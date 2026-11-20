"""Observe one selected KakaoTalk room's local model setter; emit NDJSON."""

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import sys
import time
import threading
from collections import deque
from datetime import datetime, timezone

EXPECTED_HASH = "bfb4206321786d0f5c8a9e0ff2a1959e0e901a18bcea40a652b49229b8b86bf1"
PROJECT = Path(__file__).resolve().parents[2]
OUTPUT_ROOT = PROJECT / ".generated" / "collector"


def emit(value, destination=sys.stdout):
    try:
        destination.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
        destination.flush()
    except (BrokenPipeError, OSError):
        # Cleanup must still run when the owning extension closes its pipes.
        pass


def process_identity(pid):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        buffer = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(buffer))
        if not kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(item) for item in times)):
            raise ctypes.WinError(ctypes.get_last_error())
        created = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
        return buffer.value, str(created)
    finally:
        kernel.CloseHandle(handle)


def load_metadata(path):
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    return validate_metadata(value)


def validate_metadata(value):
    if value.get("schemaVersion") != 1 or value.get("fileSha256") != EXPECTED_HASH:
        raise ValueError("Unsupported metadata build.")
    observed = datetime.fromisoformat(value["observedAt"])
    age = (datetime.now(timezone.utc) - observed).total_seconds()
    if not 0 <= age <= 600:
        raise ValueError("Discovery metadata is older than ten minutes; run prepare.ps1 again.")
    actual_path, started = process_identity(value["pid"])
    if os.path.normcase(actual_path) != os.path.normcase(value["path"]) or started != value["processStartFileTime"]:
        raise ValueError("Process identity changed; run prepare.ps1 again.")
    if Path(actual_path).name.lower() != "kakaotalk.exe":
        raise ValueError("Expected KakaoTalk.exe.")
    with open(actual_path, "rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != EXPECTED_HASH:
        raise ValueError("Client build differs from the analyzed build.")
    return value


def accept_event(value, room_id):
    if not isinstance(value, dict) or value.get("version") != 1 or value.get("type") != "message" or value.get("source") != "client":
        raise ValueError("Invalid observer event.")
    if value.get("roomId") != room_id:
        raise ValueError("Observer emitted an unselected room.")
    for name in ("id", "roomId", "senderId"):
        if not isinstance(value.get(name), str) or not re.fullmatch(r"[1-9][0-9]{0,19}", value[name]):
            raise ValueError("Invalid message identity.")
    for name, maximum in (("text", 16384), ("roomTitle", 256), ("sender", 256), ("timestamp", 40)):
        if not isinstance(value.get(name), str) or not value[name].strip() or len(value[name]) > maximum:
            raise ValueError("Invalid message field: " + name)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", type=Path, default=OUTPUT_ROOT / "session.json")
    parser.add_argument("--metadata-stdin", action="store_true", help="Read metadata and parent control commands through private stdin.")
    parser.add_argument("--initial-snapshot", action="store_true", help="Read the selected room's latest cached text once, marked as a snapshot.")
    parser.add_argument("--duration", type=int, default=180)
    parser.add_argument("--max-events", type=int, default=0)
    parser.add_argument("--include-existing", action="store_true", help="Include known IDs when the UI renders them again; does not synthesize calls.")
    parser.add_argument("--audit", help="Save counts and message hashes, without message text, under .generated/collector.")
    options = parser.parse_args()
    if not 1 <= options.duration <= 3600 or options.max_events < 0:
        parser.error("duration must be 1..3600; max-events must be nonnegative")
    if options.audit and not re.fullmatch(r"[a-z0-9-]+\.json", options.audit):
        parser.error("audit must be a simple JSON filename")
    if os.name != "nt":
        raise RuntimeError("This observer supports Windows x64 only.")
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    emit({"status": "metadata"}, sys.stderr)
    if options.metadata_stdin:
        metadata_line = sys.stdin.readline(2 * 1024 * 1024)
        if not metadata_line.endswith("\n"):
            raise ValueError("Incomplete discovery metadata.")
        metadata = validate_metadata(json.loads(metadata_line))
    else:
        metadata = load_metadata(options.metadata)
    import frida
    emit({"status": "runtime-loaded"}, sys.stderr)

    if frida.__version__ != "17.26.3":
        raise RuntimeError("Use the pinned Frida version in requirements.txt.")
    inbox = queue.Queue(maxsize=64)
    session = None
    script = None
    finalized = False
    seen = set()
    seen_order = deque()
    audit_events = []
    failure = None
    exit_reason = "duration-ended"
    cleanup = {"hookRestored": False, "scriptUnloaded": False, "sessionDetached": False}
    counters = {}
    event_count = 0
    function_entry_count = 0
    parent_stop = threading.Event()
    parent_ping = [time.monotonic()]
    requests = queue.Queue(maxsize=1)

    def parent_commands():
        try:
            while True:
                line = sys.stdin.readline(2 * 1024 * 1024)
                if not line or not line.endswith("\n"):
                    break
                request = json.loads(line)
                command = request.get("command")
                if command == "stop":
                    break
                if command == "history":
                    if not isinstance(request.get("id"), str) or not re.fullmatch(r"[0-9]{1,20}", request["id"]):
                        break
                    requests.put_nowait(request)
                elif command != "ping":
                    break
                parent_ping[0] = time.monotonic()
        except (ValueError, OSError, queue.Full):
            pass
        finally:
            parent_stop.set()

    if options.metadata_stdin:
        threading.Thread(target=parent_commands, daemon=True).start()

    def receive(message, data):
        try:
            inbox.put_nowait(message)
        except queue.Full:
            # An unresponsive host stops renewing the agent heartbeat.
            pass

    def detached(reason, crash=None):
        receive({"type": "detached", "reason": reason}, None)

    def deliver(events):
        nonlocal event_count, function_entry_count
        for raw in events:
            event = accept_event(raw, metadata["roomId"])
            key = (event["roomId"], event["id"])
            if key in seen:
                continue
            seen.add(key)
            seen_order.append(key)
            if len(seen_order) > 16384:
                seen.discard(seen_order.popleft())
            emit(event)
            event_count += 1
            if event.get("observation") == "ui-model-setter":
                function_entry_count += 1
            if options.audit:
                audit_events.append({
                "id": event["id"], "roomId": event["roomId"], "senderId": event["senderId"],
                "senderResolved": event.get("senderResolved", False), "textCharacters": len(event["text"]),
                "textSha256": hashlib.sha256(event["text"].encode("utf-8")).hexdigest(),
                "observedAt": event["timestamp"], "observation": event.get("observation"),
                })

    try:
        emit({"status": "attaching"}, sys.stderr)
        session = frida.get_local_device().attach(metadata["pid"])
        session.on("detached", detached)
        script = session.create_script((Path(__file__).with_name("agent.js")).read_text(encoding="utf-8"), name="kakao-local-message-observer")
        script.on("message", receive)
        emit({"status": "loading"}, sys.stderr)
        script.load()
        configuration = dict(metadata, duration=options.duration, includeExisting=options.include_existing, initialSnapshot=options.initial_snapshot)
        emit({"status": "configuring"}, sys.stderr)
        ready = script.exports_sync.configure(configuration)
        emit({"status": "ready", **ready, "roomTitle": metadata["roomTitle"], "duration": options.duration}, sys.stderr)
        deadline = time.monotonic() + options.duration + 2
        ping_at = time.monotonic()
        while time.monotonic() < deadline:
            if options.metadata_stdin and (parent_stop.is_set() or time.monotonic() - parent_ping[0] > 10):
                exit_reason = "parent-disconnected"
                break
            try:
                request = requests.get_nowait()
            except queue.Empty:
                request = None
            if request:
                try:
                    actual_path, started = process_identity(metadata["pid"])
                    if started != metadata["processStartFileTime"] or os.path.normcase(actual_path) != os.path.normcase(metadata["path"]):
                        raise ValueError("Client session changed.")
                    events = [accept_event(event, metadata["roomId"]) for event in script.exports_sync.history(request["params"])]
                    emit({"status": "history", "requestId": request["id"], "messages": events}, sys.stderr)
                except Exception as error:
                    emit({"status": "history", "requestId": request["id"], "error": str(error)}, sys.stderr)
            try:
                message = inbox.get(timeout=0.2)
            except queue.Empty:
                message = None
            if message:
                if message["type"] == "error":
                    raise RuntimeError(message.get("description", "Observer script error."))
                if message["type"] == "detached":
                    exit_reason = "target-detached:" + message["reason"]
                    break
                if message["type"] == "send":
                    payload = message["payload"]
                    if payload.get("kind") == "batch":
                        deliver(payload["events"])
                        script.exports_sync.ack(payload["sequence"])
                    elif payload.get("kind") == "stopped":
                        deliver(payload["events"])
                        counters = payload["counters"]
                        cleanup["hookRestored"] = payload["restored"]
                        finalized = True
                        exit_reason = payload["reason"]
                        break
            if options.max_events and event_count >= options.max_events:
                exit_reason = "max-events"
                break
            if time.monotonic() >= ping_at:
                status = script.exports_sync.ping()
                counters = status["counters"]
                if options.metadata_stdin:
                    emit({"status": "health", "counters": counters}, sys.stderr)
                ping_at = time.monotonic() + 2
    except KeyboardInterrupt:
        exit_reason = "keyboard-interrupt"
    except Exception as error:
        failure = str(error)
        exit_reason = "error"
        emit({"status": "error", "message": failure}, sys.stderr)
    finally:
        if script is not None:
            if not finalized:
                try:
                    result = script.exports_sync.stop()
                    deliver(result["events"])
                    counters = result["counters"]
                    cleanup["hookRestored"] = result["restored"]
                except Exception as error:
                    cleanup["stopError"] = str(error)
            try:
                script.unload()
                cleanup["scriptUnloaded"] = True
            except Exception as error:
                cleanup["unloadError"] = str(error)
        if session is not None:
            try:
                session.detach()
                cleanup["sessionDetached"] = True
            except Exception as error:
                cleanup["detachError"] = str(error)
        summary = {
            "observedAt": datetime.now(timezone.utc).isoformat(), "pid": metadata["pid"],
            "roomId": metadata["roomId"], "fileSha256": EXPECTED_HASH, "status": "error" if failure else "stopped",
            "reason": exit_reason, "eventCount": event_count, "events": audit_events,
            "counters": counters, "cleanup": cleanup, "functionEntryObserved": function_entry_count > 0,
            "networkReceiveVerified": False, "includeExisting": options.include_existing,
        }
        if options.audit:
            OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
            (OUTPUT_ROOT / options.audit).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        emit({"status": summary["status"], "reason": exit_reason, "eventCount": event_count, "counters": counters, "cleanup": cleanup}, sys.stderr)
    return 1 if failure or not all(cleanup.get(key) for key in ("hookRestored", "scriptUnloaded", "sessionDetached")) else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        emit({"status": "error", "message": str(error)}, sys.stderr)
        sys.exit(1)
