"""Local Chat process entry point for the packaged receiver and reply selector."""

import json
from pathlib import Path
import struct
import sys

import frida
from collector import collect
import reply_worker


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    sys.argv = [sys.argv[0], *sys.argv[2:]]
    if command == "check":
        for filename in (Path(collect.__file__).with_name("agent.js"),
                         Path(reply_worker.__file__).with_name("reply-agent.js")):
            if not filename.read_text(encoding="utf-8").strip():
                raise ValueError("Worker asset is empty.")
        print(json.dumps({"protocol": 1, "bits": struct.calcsize("P") * 8,
                          "frida": frida.__version__, "frozen": getattr(sys, "frozen", False)}))
        return 0
    if command == "collect":
        try:
            return collect.main()
        except Exception as error:
            collect.emit({"status": "error", "message": str(error)}, sys.stderr)
            return 1
    if command == "reply":
        try:
            reply_worker.main()
            return 0
        except Exception:
            print(json.dumps({"status": "error", "code": "REPLY_PREPARE_FAILED", "clean": False}), flush=True)
            return 1
    print("Usage: local-chat-worker.exe check|collect|reply", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
