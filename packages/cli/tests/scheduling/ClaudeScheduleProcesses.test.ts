import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { assertScheduleHostAvailable, scheduleProcesses } from '../../src/scheduling/claude/ClaudeScheduleProcesses';
import * as runtime from '../../src/delegation/OwnershipRuntime';
vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
const originalGetuid = process.getuid;
afterEach(() => {
  vi.restoreAllMocks();
  if (!originalGetuid) delete (process as unknown as { getuid?: unknown }).getuid;
});
const current = { pid: 201, birth: 'current', command: 'fixture-native --resume original' };
describe('native schedule host exclusion', () => {
  it('excludes the exact owner, anonymous legacy hosts and ambiguous PID evidence', () => {
    for (const command of ['fixture-native', 'fixture-native --resume original', 'fixture-native --session-id=original']) {
      expect(() => assertScheduleHostAvailable([current, { pid: 202, command }], 'original', 201, 'fixture-native')).toThrow('Another native host');
    }
    expect(() => assertScheduleHostAvailable([current, { pid: 202, birth: 'old', command: 'renamed' }],
      'original', 201, 'fixture-native', { pid: 202, birth: 'old' })).toThrow('still alive');
    expect(() => assertScheduleHostAvailable([current, { pid: 202, command: 'renamed' }],
      'original', 201, 'fixture-native', { pid: 202, birth: 'old' })).toThrow('still alive');
    expect(() => assertScheduleHostAvailable([], 'original', 201, 'fixture-native')).toThrow('identity');
  });
  it('preserves siblings and treats PID reuse as host evidence, never old task completion', () => {
    const others = [{ pid: 202, birth: 'new', command: 'unrelated' }, { pid: 203, command: 'fixture-native --session-id sibling' }];
    expect(assertScheduleHostAvailable([current, ...others], 'original', 201, 'fixture-native', { pid: 202, birth: 'old' })).toEqual({ pid: 201, birth: 'current' });
  });
  it('handles native argv, executable paths with spaces, Windows paths and node launchers', () => {
    expect(() => assertScheduleHostAvailable([current, { pid: 202, command: '',
      argv: ['/fixture directory/fixture-native', '--resume', 'original'] }], 'original', 201, '/fixture directory/fixture-native')).toThrow('Another native host');
    expect(() => assertScheduleHostAvailable([current, { pid: 202,
      command: '"C:\\Program Files\\fixture-native.exe" --resume original' }], 'original', 201, 'fixture-native')).toThrow('Another native host');
    expect(() => assertScheduleHostAvailable([current, { pid: 202,
      command: 'node /fixture/fixture-native --resume original' }], 'original', 201, 'fixture-native')).toThrow('Another native host');
  });
  it('allows unrelated unattributed hosts only when predecessor identity is already known', () => {
    const processes = [current, { pid: 202, command: 'fixture-native' }];
    expect(assertScheduleHostAvailable(processes, 'original', 201, 'fixture-native', undefined, false).pid).toBe(201);
    expect(() => assertScheduleHostAvailable(processes, 'original', 201, 'fixture-native')).toThrow('Another native host');
    expect(() => assertScheduleHostAvailable([current, { pid: 202, command: 'node wrapper.js --input-format stream-json --output-format=stream-json --resume original' }],
      'original', 201, 'fixture-native', undefined, false)).toThrow('Another native host');
  });
  it('does not treat another backend stream protocol as ownership of a legacy Claude session', () => {
    const other = { pid: 202, command: 'agy --input-format=stream-json --output-format=stream-json --conversation unrelated' };
    expect(assertScheduleHostAvailable([current, other], 'original', 201, 'fixture-native').pid).toBe(201);
    const wrapper = { pid: 201, command: 'node /fixture/native-wrapper.js --resume original' };
    expect(() => assertScheduleHostAvailable([wrapper, { pid: 202, command: 'node /fixture/native-wrapper.js --input-format=stream-json --output-format=stream-json' }],
      'original', 201, 'fixture-native')).toThrow('Another native host');
  });
  it('reads a bounded Linux inventory and refuses incomplete same-user evidence', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    if (!process.getuid) Object.defineProperty(process, 'getuid', { value: () => 1000, writable: true, configurable: true });
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    vi.spyOn(runtime, 'processBirth').mockReturnValue('birth');
    const names = vi.spyOn(fs, 'readdirSync').mockReturnValue([String(process.pid), '201', '202', '203', 'self'] as any);
    vi.spyOn(fs, 'statSync').mockImplementation((name: any) => ({ uid: String(name).endsWith('202') ? 2000 : 1000 }) as any);
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation((name: any) => {
      if (String(name).includes('/203/')) throw Object.assign(new Error(), { code: 'ENOENT' });
      return 'fixture-native\0--resume\0original\0';
    });
    expect(scheduleProcesses()).toHaveLength(2);
    read.mockImplementation(() => { throw Object.assign(new Error(), { code: 'EACCES' }); });
    expect(scheduleProcesses).toThrow('incomplete');
    names.mockReturnValue([]); expect(scheduleProcesses).toThrow('namespace');
  });
  it('parses macOS and Windows process identity without relying on host-native path syntax', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.mocked(execFileSync).mockReturnValue('201 Mon Nov 16 10:00:00 2026 fixture-native --resume original\n');
    expect(scheduleProcesses()[0]).toMatchObject({ pid: 201, command: 'fixture-native --resume original' });
    vi.mocked(execFileSync).mockReturnValue('invalid'); expect(scheduleProcesses).toThrow('incomplete');
    platform.mockReturnValue('win32');
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify([{ ProcessId: 201, CreationDate: 'birth', Name: 'fixture-native' }]));
    expect(scheduleProcesses()).toEqual([{ pid: 201, birth: 'birth', command: 'fixture-native' }]);
    vi.mocked(execFileSync).mockReturnValue('{}'); expect(scheduleProcesses).toThrow('incomplete');
    platform.mockReturnValue('freebsd'); expect(scheduleProcesses).toThrow('unsupported');
  });
});
