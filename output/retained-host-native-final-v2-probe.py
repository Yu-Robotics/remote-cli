#!/usr/bin/env python3
"""Linux-only retained production host acceptance. Never mounts host HOME or auth.

Requires built packages/cli/{dist,native}, node_modules, bwrap, and the installed
native executable. Uses versioned invocation-scope observation and original frontend.cjs as
fixture dependencies. The only network is the namespace's loopback fake provider.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backend', choices=['claude', 'agy'])
    parser.add_argument('--native')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    destination = Path(args.output)
    if destination.exists():
        raise SystemExit('Refusing to overwrite prior evidence')
    repo = Path(__file__).resolve().parent.parent
    binary = Path(shutil.which(args.native or args.backend) or args.native or args.backend).resolve(strict=True)
    if not shutil.which('bwrap') or not Path('/proc').exists():
        raise SystemExit('Linux/Bubblewrap required; no unisolated fallback')
    root = Path(tempfile.mkdtemp(prefix='retained-native-')).resolve()
    evidence = {'backend': args.backend, 'nativeSha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                'sourceRevision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(),
                'compiledSources': {name: hashlib.sha256((repo / 'packages/cli/dist/sessionHost' / (name + '.js')).read_bytes()).hexdigest()
                                    for name in ['RetainedRuntime', 'RetainedFrontend', 'HostServer', 'HostClient']}}
    evidence['fixtureVersion'] = 'final-v2-invocation-scope-and-explicit-stop'
    evidence['scheduleServiceSha256'] = hashlib.sha256((repo / 'packages/cli/dist/scheduling/ScheduleService.js').read_bytes()).hexdigest()
    evidence['fixtureSha256'] = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in [Path(__file__).name, 'retained-host-native-final-v2-runner.cjs', 'retained-host-native-frontend.cjs']}
    try:
        for name in ['runner.cjs', 'frontend.cjs']:
            source = 'retained-host-native-final-v2-runner.cjs' if name == 'runner.cjs' else 'retained-host-native-frontend.cjs'
            shutil.copyfile(Path(__file__).with_name(source), root / name)
        for name in ['home', 'home/workspace', 'tmp', 'config', 'cache', 'data']:
            (root / name).mkdir(mode=0o700)
        if args.backend == 'agy':
            settings = root / 'home/.gemini/antigravity-cli'
            settings.mkdir(parents=True)
            model = {'modelName': 'gemini-api://generativelanguage.googleapis.com/v1beta/models/acp-fixture',
                     'label': 'ACP Fixture', 'maxTokens': 32768, 'toolFormatterType': 'TOOL_FORMATTER_TYPE_NONE',
                     'modelFeatures': {'supportsThinking': False, 'supportsImages': False, 'supportsToolCalls': True}}
            (settings / 'settings.json').write_text(json.dumps({'modelProvider': 'gemini', 'model': 'ACP Fixture',
                'customModelsConfig': {'customModels': {'fixture': model}}, 'toolPermission': 'always-proceed',
                'disableSlashCommands': True, 'permissions': {'deny': ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)']}}))
        command = ['bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--ro-bind', '/usr', '/usr',
                   '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
                   '--dir', '/etc', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
                   '--ro-bind', str(binary), '/native/' + args.backend, '--bind', str(root), '/probe',
                   '--ro-bind', str(repo / 'packages/cli/dist'), '/app/dist',
                   '--ro-bind', str(repo / 'packages/cli/native'), '/app/native',
                   '--ro-bind', str(repo / 'node_modules'), '/app/node_modules', '--chdir', '/probe/home/workspace',
                   '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/probe/home',
                   '--setenv', 'USERPROFILE', '/probe/home', '--setenv', 'TMPDIR', '/probe/tmp',
                   '--setenv', 'XDG_CONFIG_HOME', '/probe/config', '--setenv', 'XDG_CACHE_HOME', '/probe/cache',
                   '--setenv', 'XDG_DATA_HOME', '/probe/data', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'TZ', 'UTC',
                   '/usr/bin/node', '/probe/runner.cjs', args.backend]
        try:
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=470)
            evidence['namespaceExitCode'] = result.returncode
            evidence['namespaceStderrBytes'] = len(result.stderr)
        except subprocess.TimeoutExpired:
            evidence['launcherTimeout'] = True
        if (root / 'result.json').exists():
            evidence.update(json.loads((root / 'result.json').read_text()))
        else:
            evidence['error'] = 'Runner did not produce structured evidence'
        # subprocess.run has joined the namespace leader; kernel destroys all of
        # this isolated PID namespace's descendants, even after fixture failure.
        evidence.setdefault('cleanup', {})['namespaceJoined'] = True
    finally:
        shutil.rmtree(root)
        evidence.setdefault('cleanup', {})['disposableRootRemoved'] = not root.exists()
        destination.write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps({key: evidence.get(key) for key in ['backend', 'error', 'assertions', 'counts', 'cleanup']}))
    return int(bool(evidence.get('error') or evidence.get('launcherTimeout') or evidence.get('namespaceExitCode')))


if __name__ == '__main__':
    raise SystemExit(main())
