"""Select a loaded native reply target through the client's UI thread. Never sends."""
import hashlib
import json
from pathlib import Path
import re
import secrets
import sys
import threading
import ctypes
import msvcrt

from collector.collect import BUILDS, process_identity

def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8')
    raw = sys.stdin.readline(8193)
    if not raw.endswith('\n') or len(raw) > 8192:
        raise ValueError('Invalid request frame.')
    request = json.loads(raw)
    if type(request.get('pid')) is not int or request['pid'] < 1:
        raise ValueError('Invalid process identity.')
    for value in (request.get('roomId'), request.get('replyTo', {}).get('id'), request.get('replyTo', {}).get('senderId')):
        if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,19}',value) or int(value) > 2**64-1:
            raise ValueError('Invalid message identity.')
    if not isinstance(request.get('roomTitle'),str) or not 1 <= len(request['roomTitle']) <= 256:
        raise ValueError('Invalid room title.')
    filename, started = process_identity(request['pid'])
    target = request.get('inputTarget')
    if target is not None:
        if not isinstance(target, dict) or target.get('processStartFileTime') != started:
            raise ValueError('Input target process changed.')
        for key in ('dialog', 'window', 'editor'):
            address = target.get(key)
            if not isinstance(address, str) or not re.fullmatch(r'0x[0-9a-fA-F]{1,16}', address) or not 0 < int(address, 16) <= 0x7fffffffffff:
                raise ValueError('Invalid input target address.')
    digest = hashlib.sha256(Path(filename).read_bytes()).hexdigest()
    if Path(filename).name.lower() != 'kakaotalk.exe' or digest not in BUILDS:
        raise ValueError('Unsupported client build.')
    import frida
    if frida.__version__ != '17.26.3':
        raise ValueError('Unsupported observer runtime.')
    session = frida.get_local_device().attach(request['pid'])
    source = 'const CLIENT_BUILD = ' + json.dumps(BUILDS[digest]) + ';\n'
    source += Path(__file__).with_name('reply-agent.js').read_text(encoding='utf-8')
    script = session.create_script(source)
    result = {'status':'error','code':'REPLY_PREPARE_FAILED'}
    clean = False
    finished = threading.Event()
    watcher = None
    try:
        script.load()
        if process_identity(request['pid']) != (filename, started):
            raise ValueError('Process identity changed.')
        def watch_parent():
            # Poll pipe liveness without leaving a blocked Python input thread at shutdown.
            try:
                kernel=ctypes.WinDLL('kernel32',use_last_error=True)
                kernel.PeekNamedPipe.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p]
                handle=msvcrt.get_osfhandle(sys.stdin.fileno())
                while not finished.wait(0.1):
                    if not kernel.PeekNamedPipe(handle,None,0,None,None,None):
                        script.exports_sync.cancel()
                        return
            except Exception:
                pass
        watcher=threading.Thread(target=watch_parent,daemon=True)
        watcher.start()
        request['nonce'] = secrets.token_hex(16)
        result = script.exports_sync.prepare(request)
    finally:
        finished.set()
        if watcher is not None:
            watcher.join(timeout=1)
        try:
            clean = script.exports_sync.stop()
        finally:
            try:
                script.unload()
            finally:
                session.detach()
    result['clean'] = clean
    print(json.dumps(result,ensure_ascii=False),flush=True)

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status':'error','code':'REPLY_PREPARE_FAILED','clean':False}),flush=True)
        sys.exit(1)
