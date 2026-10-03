import { describe, expect, it } from 'vitest';
import { backendProbeFailure, getBackendCommand } from '../src/utils/BackendCommand';
import type { BackendKey, ExecutorConfig } from '../src/types/config';

describe('backend command selection', () => {
  it.each<BackendKey>(['claude', 'codex', 'agy', 'opencode', 'kimi', 'pi', 'dsh', 'zcode'])('honors the configured executable without shell parsing or fallback: %s', backend => {
    const command = `/opt/example tools/${backend}`;
    const config: ExecutorConfig = { type: 'auto', [backend]: { command } };
    expect(getBackendCommand(backend, config)).toBe(command);
    expect(getBackendCommand(backend, { type: 'auto', [backend]: { command: '' } })).toBe('');
    expect(getBackendCommand(backend)).toBe(backend === 'zcode' ? undefined : backend);
  });

  it.each(['auto', 'claude-persistent'])('uses the Claude override for executor aliases: %s', type => {
    expect(getBackendCommand(type, { type: 'auto', claude: { command: '/opt/example/claude' } })).toBe('/opt/example/claude');
  });
});

describe('bounded executable probe diagnostics', () => {
  it.each([
    [{ code: 'ENOENT' }, 'executable, interpreter, or working directory'],
    [{ code: 'EACCES' }, 'permission'],
    [{ code: 'EPERM' }, 'permission'],
    [{ code: 1 }, 'exited unsuccessfully'],
    [{ code: 'ETIMEDOUT' }, 'timed out'],
    [{ killed: true }, 'timed out or was interrupted'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, 'output exceeded'],
    [new Error('sensitive fixture stderr'), 'probe failed'],
    [undefined, 'probe failed'],
  ])('classifies failures without exposing raw stderr or claiming login status: %j', (error, reason) => {
    const output = backendProbeFailure(error);
    expect(output).toContain(reason);
    expect(output).not.toContain('sensitive fixture');
    expect(output).not.toContain('not installed');
    expect(output).not.toContain('authenticated');
  });
});
