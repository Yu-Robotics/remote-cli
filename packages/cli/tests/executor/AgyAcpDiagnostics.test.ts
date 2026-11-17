import { describe, expect, it } from 'vitest';
import { AgyAcpStartupError, describeAgyAcpFailure } from '../../src/executor/agy/AgyAcpDiagnostics';

describe('AGY ACP startup diagnostics', () => {
  it.each([
    ['ACP error -32000: Authentication required', 'authentication-required', 'rpc=-32000'],
    ['Error: flags provided but not defined: -model', 'unsupported-argument', undefined],
    ['ACP error -32602: Unknown model ID: synthetic', 'unsupported-setting', 'rpc=-32602'],
    ['AGY ACP model selection could not be confirmed. No prompt was sent.', 'unsupported-setting', undefined],
    ['ACP session/new timed out after 10000ms', 'timeout', undefined],
    ['AGY ACP transcript handle support is unavailable.', 'initialization-failed', undefined],
    ['Managed native cleanup support is unavailable for this platform or architecture', 'native-helper-unavailable', undefined],
    ['ACP process exited: code=1 signal=null', 'process-exited', undefined],
  ])('classifies %s without forwarding native text', (message, reason, code) => {
    const result = describeAgyAcpFailure(new Error(message), 'initialize');
    expect(result).toContain('stage=initialize');
    expect(result).toContain(`reason=${reason}`);
    if (code) expect(result).toContain(code);
  });

  it.each(['ENOENT', 'EACCES', 'EPERM', 'EADDRINUSE'])('retains only known system code %s', code => {
    expect(describeAgyAcpFailure(Object.assign(new Error('synthetic'), { code }))).toContain(`system=${code}`);
  });

  it('never includes arbitrary errors, paths, credentials, stderr or server data', () => {
    const secret = 'synthetic-private-value';
    const error = Object.assign(new Error(`ACP error -32602: Unknown model ID: ${secret}; https://example.com/${secret}`), { code: secret });
    const wrapped = new AgyAcpStartupError('session-settings', error);
    expect(wrapped.message).toBe('AGY ACP startup failed (stage=session-settings, reason=unsupported-setting, rpc=-32602).');
    expect(wrapped.cause).toBeUndefined();
    expect(JSON.stringify(wrapped)).not.toContain(secret);
    expect(describeAgyAcpFailure(wrapped)).toBe(wrapped.message);
    expect(describeAgyAcpFailure(secret)).not.toContain(secret);
    expect(describeAgyAcpFailure(Object.assign(new Error(secret), { code: secret }))).not.toContain(secret);
    const cleanup = new AgyAcpStartupError('startup', wrapped, new Error(secret));
    expect(cleanup.message).toContain('stage=session-settings');
    expect(cleanup.message).toContain('stage=cleanup');
    expect(cleanup.message).not.toContain(secret);
  });
});
