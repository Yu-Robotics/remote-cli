import { AgyHookOwnershipError } from '../../src/scheduling/agy/AgyHookOwnership';
import { describe, expect, it } from 'vitest';
import { AgyAcpStartupError, describeAgyAcpFailure } from '../../src/executor/agy/AgyAcpDiagnostics';

describe('AGY ACP startup diagnostics', () => {
  it.each(['active', 'unknown', 'changed'] as const)('gives precise %s overlay guidance without blaming native helpers', category => {
    const error = new AgyHookOwnershipError(category);
    const wrapped = new AgyAcpStartupError('hooks', error);
    expect(wrapped.message).toBe(error.message); expect(wrapped.message).not.toContain('Verify AGY');
  });
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
    expect(wrapped.message).toBe('AGY ACP startup failed (stage=session-settings, reason=unsupported-setting, rpc=-32602). Verify AGY 1.5.10 or newer and the remote-cli native helper for your platform. No legacy transport fallback is available.');
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
