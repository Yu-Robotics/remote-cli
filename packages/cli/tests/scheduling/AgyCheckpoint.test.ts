import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgyCheckpoint, definitionDigest, loadCheckpointSession, scheduleDigest } from '../../src/scheduling/agy/AgyCheckpoint';
import type { AcpTransport } from '../../src/executor/acp/AcpClient';
let root: string, file: string, checkpoint: AgyCheckpoint;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-checkpoint-')));
  file = path.join(root, 'journal'); checkpoint = new AgyCheckpoint(file, 'synthetic-config');
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const jobs = { 'synthetic-job': definitionDigest(['exact', 'intent']) };
function clean() { const value = checkpoint.prepare('original-session', jobs); checkpoint.confirm(value); return value; }
function client() {
  let exit!: () => void;
  const transport = { loadSession: vi.fn(async (sessionId: string) => ({ sessionId })), newSession: vi.fn(),
    setConfigOption: vi.fn(), sendCancel: vi.fn(), destroy: vi.fn(), deleteSession: vi.fn(),
    waitForExit: () => new Promise<void>(resolve => { exit = resolve; }), prompt: vi.fn(async () => ({ stopReason: 'end_turn' })) };
  return { transport: transport as unknown as AcpTransport, mock: transport, exit: () => exit() };
}
describe('AGY one-use original-session checkpoint', () => {
  it('publishes only a matching prepared journal and consumes before native load', async () => {
    expect(checkpoint.read()).toBeUndefined();
    const prepared = checkpoint.prepare('original-session', jobs);
    expect(() => checkpoint.consume('original-session')).toThrow('unavailable');
    checkpoint.confirm(prepared);
    expect(() => checkpoint.consume('wrong-session')).toThrow('unavailable');
    const permit = checkpoint.consume('original-session');
    expect(checkpoint.read()?.state).toBe('consumed');
    expect(() => checkpoint.confirm(prepared)).toThrow('changed');
    const { transport, mock, exit } = client();
    const loaded = await loadCheckpointSession(transport, permit, root, []);
    expect(mock.loadSession).toHaveBeenCalledWith('original-session', root, []);
    expect(loaded.sessionAdmission?.('original-session')).toBeTruthy();
    expect(loaded.sessionAdmission?.('other')).toBeUndefined();
    await loaded.prompt('original-session', []); expect(mock.prompt).toHaveBeenCalledOnce();
    await expect(loadCheckpointSession(transport, permit, root, [])).rejects.toThrow('consumed');
    exit(); await Promise.resolve(); expect(loaded.sessionAdmission?.('original-session')).toBeUndefined();
  });
  it.each(['sendCancel', 'setConfigOption', 'newSession', 'loadSession', 'destroy', 'deleteSession'])(
    'revokes resumed admission on %s', async method => {
      clean(); const { transport } = client();
      const loaded = await loadCheckpointSession(transport, checkpoint.consume('original-session'), root, []);
      await (loaded as any)[method]('original-session');
      expect(loaded.sessionAdmission?.('original-session')).toBeUndefined();
    });
  it('refuses fabricated permits, native identity changes and replay after failed load', async () => {
    const { transport, mock } = client();
    await expect(loadCheckpointSession(transport, { sessionId: 'original-session', checkpointId: 'fabricated' }, root, [])).rejects.toThrow('invalid');
    clean(); const permit = checkpoint.consume('original-session');
    mock.loadSession.mockResolvedValueOnce({ sessionId: 'wrong' });
    await expect(loadCheckpointSession(transport, permit, root, [])).rejects.toThrow('different');
    expect(() => checkpoint.consume('original-session')).toThrow('unavailable');
  });
  it('rejects configuration change, corruption, oversized files and changed preparation', () => {
    const first = clean();
    expect(() => new AgyCheckpoint(file, 'different').read()).toThrow('incompatible');
    checkpoint.prepare('original-session', jobs);
    expect(() => checkpoint.confirm(first)).toThrow('changed');
    for (const value of ['{', '{}', JSON.stringify({ ...first, jobs: [] }), JSON.stringify({ ...first, jobs: { x: 'invalid' } }), ' '.repeat(65537)]) {
      fs.writeFileSync(file, value); expect(() => checkpoint.read()).toThrow();
    }
  });
  it('never publishes clean if journal rename fails', () => {
    const prepared = checkpoint.prepare('original-session', jobs);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('Synthetic durability failure'); });
    expect(() => checkpoint.confirm(prepared)).toThrow('durability');
    expect(checkpoint.read()?.state).toBe('prepared');
    expect(fs.readdirSync(root)).toEqual(['journal']);
  });
  it('retains a competing or crashed journal transition fence', () => {
    clean(); fs.mkdirSync(file + '.lock');
    expect(() => checkpoint.consume('original-session')).toThrow('already owned');
    expect(() => checkpoint.prepare('original-session', jobs)).toThrow('already owned');
    expect(checkpoint.read()?.state).toBe('clean');
  });
  it('binds exact intent/settings while excluding changing recovery status', () => {
    const input = { id: 'job', threadId: 'thread', backend: 'agy' as const, cwd: root, prompt: 'work',
      rule: { kind: 'cron' as const, expression: '* * * * *', timezone: 'UTC' } };
    expect(scheduleDigest(input)).toBe(scheduleDigest({ ...input, recovery: {} as any }));
    for (const changed of [{ prompt: 'other' }, { model: 'other' }, { effort: 'high' }, { cwd: path.dirname(root) }, { id: 'different' }]) {
      expect(scheduleDigest({ ...input, ...changed })).not.toBe(scheduleDigest(input));
    }
  });
});
