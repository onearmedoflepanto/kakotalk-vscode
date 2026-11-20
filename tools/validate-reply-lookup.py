"""Compare native input lookup paths without selecting a reply or sending text."""
import copy
import json
from pathlib import Path
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools' / 'collector'))
from collect import BUILDS, process_identity
import hashlib
import frida


def main():
    request = json.loads((ROOT / '.generated/integration/input-cache-validation.json').read_text(encoding='utf-8'))['request']
    filename, started = process_identity(request['pid'])
    assert request['inputTarget']['processStartFileTime'] == started
    digest = hashlib.sha256(Path(filename).read_bytes()).hexdigest()
    assert digest in BUILDS
    assert frida.__version__ == '17.26.3'
    source = 'const CLIENT_BUILD = ' + json.dumps(BUILDS[digest]) + ';\n'
    source += (ROOT / 'tools/reply-agent.js').read_text(encoding='utf-8')
    source += "\nrpc.exports.lookuponly = request => { const c=locate(request); return {window:c.window.toString(),editor:c.editor.toString()}; };"
    session = frida.get_local_device().attach(request['pid'])
    script = session.create_script(source)
    measurements = {}
    try:
        script.load()
        assert process_identity(request['pid']) == (filename, started)
        for name in ('fullScan', 'validatedTarget'):
            value = copy.deepcopy(request)
            if name == 'fullScan':
                value.pop('inputTarget')
            samples = []
            for _ in range(3):
                begin = time.perf_counter()
                found = script.exports_sync.lookuponly(value)
                samples.append(round((time.perf_counter() - begin) * 1000, 3))
                for key in ('window', 'editor'):
                    assert int(found[key], 16) == int(request['inputTarget'][key], 16)
            measurements[name] = {'samplesMs': samples, 'medianMs': statistics.median(samples)}
        stale = copy.deepcopy(request)
        stale['inputTarget']['editor'] = '0x1'
        rejected = False
        try:
            script.exports_sync.lookuponly(stale)
        except frida.InvalidOperationError:
            raise
        except Exception as error:
            rejected = 'ROOM_CHANGED' in str(error)
        assert rejected, 'Stale target accepted'
    finally:
        script.unload()
        session.detach()
    # An old process creation time must fail before attachment or UI selection.
    old_session = copy.deepcopy(request)
    old_session['inputTarget']['processStartFileTime'] = '1'
    old_session['replyTo'] = {'id': '1', 'senderId': '1'}
    child = subprocess.run([sys.executable, '-B', str(ROOT / 'tools/reply_worker.py')],
                           input=json.dumps(old_session)+'\n', encoding='utf-8', capture_output=True,
                           timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
    result = json.loads(child.stdout)
    assert child.returncode != 0 and result['status'] == 'error'
    evidence = {'measurements': measurements, 'staleTargetRejected': True, 'staleProcessSessionRejected': True,
                'sentMessages': 0, 'replySelections': 0, 'inputChanged': False,
                'scope': 'Native lookup and local RPC only; no hook installation, reply selection or submission'}
    (ROOT / '.generated/integration/reply-lookup-validation.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
