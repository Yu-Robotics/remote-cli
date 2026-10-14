import { describe, expect, it } from 'vitest';
import { isSessionControl, sessionResumeGate, SESSION_BACKENDS, validateSessionSharing } from '../../src/session/SessionResumeService';

describe('Session resume capability gate', () => {
  it.each(SESSION_BACKENDS)('does not pretend that %s can resume before certification', backend => {
    expect(sessionResumeGate('/resume', backend, { enabled: true })).toMatchObject({
      success: false, code: 'native_capability_unavailable', error: expect.stringContaining('No session was loaded or task sent'),
    });
  });

  it('reports session status separately from resume without claiming a binding', () => {
    const result = sessionResumeGate('/session', 'pi', { enabled: true });
    expect(result.error).toContain('No native session is bound');
    // The status answer points at the local-only helper instead of exposing locators.
    expect(result.error).toContain('remote-cli session show --thread <thread-name> --backend pi');
    expect(result.error).not.toContain('native resume is not available');
    expect(sessionResumeGate('/SESSION release', 'codex', { enabled: true }).error).toContain('Codex session status');
    expect(sessionResumeGate('/session', 'pi', undefined).code).toBe('sharing_disabled');
  });

  it('requires an actual boolean master opt-in', () => {
    expect(sessionResumeGate('/resume', 'pi', undefined).code).toBe('sharing_disabled');
    expect(sessionResumeGate('/resume', 'pi', { enabled: 'true' }).code).toBe('invalid_session_configuration');
    expect(sessionResumeGate('/resume', 'pi', { enabled: false, backends: { pi: { enabled: true } } }).code).toBe('sharing_disabled');
  });

  it('honors per-backend opt-out and never switches the active backend', () => {
    expect(sessionResumeGate('/resume backend codex', 'pi', { enabled: true, backends: { codex: { enabled: false } } }).code).toBe('sharing_disabled');
    expect(sessionResumeGate('/resume backend codex', 'pi', { enabled: true }).error).toContain('Codex');
    expect(sessionResumeGate('/resume backend unknown', 'pi', { enabled: true }).code).toBe('invalid_session_command');
    expect(sessionResumeGate('/resume backend', 'pi', { enabled: true }).code).toBe('invalid_session_command');
  });

  it.each(['/resume', '/resume id example-id', '/r', '/SESSION release', ' /resume\tbackend pi '])('recognizes %s before native passthrough', command => {
    expect(isSessionControl(command)).toBe(true);
  });

  it.each(['/resume-other', '/review', '/skill:resume', 'resume', '/session-file'])('does not reserve unrelated command %s', command => {
    expect(isSessionControl(command)).toBe(false);
  });

  it.each([null, true, [], { unexpected: true }, { backends: [] }, { backends: { missing: {} } },
    { backends: { pi: null } }, { backends: { pi: { enabled: 'false' } } }, { backends: { pi: { stores: [] } } }])('rejects malformed opt-in %j without changing configuration', configuration => {
    expect(validateSessionSharing(configuration)).toBeDefined();
  });

  it.each([undefined, {}, { enabled: false }, { enabled: true, backends: { pi: { enabled: true }, codex: {} } }])('accepts typed configuration %j', configuration => {
    expect(validateSessionSharing(configuration)).toBeUndefined();
  });
});
