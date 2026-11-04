import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DshManagedHistory } from '../../src/delegation/DshManagedHistory';

describe('durable DSH managed history binding', () => {
  let home: string;
  let lane: string;
  let pointer: string;
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-history-binding-')));
    lane = `delegate-lane-${randomUUID()}`;
    pointer = path.join(home, '.remote-cli', 'dsh-sessions', `${lane}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
  });
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

  it('persists an isolated scope before capture and resumes it after executor replacement', async () => {
    const first = new DshManagedHistory(home, lane, pointer);
    await first.prepare(home);
    expect(first.patch).toContain('session-persistence-jsonl');
    expect(first.patch).toContain('session-query-sqlite');
    const id = randomUUID();
    await fs.writeFile(pointer, JSON.stringify({ id, cwd: home }));
    const target = await first.capture(id);
    const replacement = new DshManagedHistory(home, lane, pointer);
    await replacement.prepare(home);
    expect(replacement.patch).toBe(first.patch);
    expect(await replacement.capture(id)).toEqual(target);
    expect(await fs.readdir(path.dirname(pointer))).toEqual([`${lane}.json`]);
  });

  it('rejects a non-managed identity before creating a history namespace', async () => {
    const history = new DshManagedHistory(home, 'ordinary-thread', pointer);
    await expect(history.prepare(home)).rejects.toThrow('managed lane');
    await expect(fs.stat(path.join(home, '.remote-cli', 'dsh-histories'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('holds an ambiguous legacy pointer without migrating or removing it', async () => {
    const bytes = JSON.stringify({ cwd: home });
    await fs.writeFile(pointer, bytes);
    const history = new DshManagedHistory(home, lane, pointer);
    await expect(history.prepare(home)).rejects.toThrow('ambiguous');
    expect(await fs.readFile(pointer, 'utf8')).toBe(bytes);
  });

  it('keeps a legacy pointer on its original native storage without claiming ownership', async () => {
    const id = randomUUID();
    await fs.writeFile(pointer, JSON.stringify({ id, cwd: home }));
    const history = new DshManagedHistory(home, lane, pointer);
    await history.prepare(home);
    expect(history.patch).toBe('');
    await expect(history.capture(id)).rejects.toThrow('legacy');
    expect(JSON.parse(await fs.readFile(pointer, 'utf8')).id).toBe(id);
  });

  it('refuses a binding recorded for another lane', async () => {
    const history = new DshManagedHistory(home, lane, pointer);
    await history.prepare(home);
    const binding = path.join(home, '.remote-cli', 'dsh-history-bindings', `${lane}.json`);
    const data = JSON.parse(await fs.readFile(binding, 'utf8'));
    data.executorThreadId = `delegate-lane-${randomUUID()}`;
    await fs.writeFile(binding, JSON.stringify(data));
    await expect(new DshManagedHistory(home, lane, pointer).prepare(home)).rejects.toThrow('not owned');
  });

  it('allocates a new scope after a directory change while retaining old history', async () => {
    const history = new DshManagedHistory(home, lane, pointer);
    await history.prepare(home);
    const old = history.patch;
    const cwd = path.join(home, 'next');
    await fs.mkdir(cwd);
    await history.prepare(cwd);
    expect(history.patch).not.toBe(old);
    expect(await fs.readdir(path.join(home, '.remote-cli', 'dsh-histories'))).toHaveLength(2);
  });
});
