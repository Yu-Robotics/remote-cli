import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureOpenCodeDeletionTarget, deleteOwnedOpenCodeSession, openCodeDeletionPreparation,
  validOpenCodeDeletionTarget, type OpenCodeDeletionTarget, type OpenCodeDeletionTransport } from '../../src/delegation/OpenCodeSessionDeletion';

const lane = 'delegate-lane-11111111-2222-4333-8444-555555555555';
const id = 'ses_owned123';
describe('OpenCode managed native deletion', () => {
  let home: string;
  let cwd: string;
  let database: string;
  let pointer: string;
  let row: Record<string, unknown>;
  let transport: OpenCodeDeletionTransport;
  let commands: string[][];
  let failDelete: boolean;
  let residue: boolean;
  const factory = () => transport;
  const recovery = () => ({ persistPrepared: vi.fn(async () => {}), persistMaintenanceState: vi.fn(async () => {}) });
  const capture = () => captureOpenCodeDeletionTarget({ sessionId: id, executorThreadId: lane, home, cwd, command: 'opencode' }, factory);
  const empty = () => ({ roots: 0, children: 0, events: 0, sequences: 0, messages: 0, parts: 0,
    todos: 0, projections: 0, inputs: 0, epochs: 0, projectId: null, cwd: null, parentId: null, createdAt: null });
  beforeEach(async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-delete-')));
    cwd = path.join(home, 'workspace');
    database = path.join(home, 'native.sqlite');
    pointer = path.join(home, '.remote-cli', 'opencode-sessions', `${lane}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.mkdir(cwd);
    await fs.writeFile(database, 'synthetic database identity');
    await fs.writeFile(pointer, JSON.stringify({ id, cwd }));
    row = { ...empty(), roots: 1, events: 2, sequences: 1, messages: 1, projectId: 'synthetic-project', cwd, createdAt: 123 };
    commands = [];
    failDelete = false;
    residue = false;
    transport = {
      run: vi.fn(async args => {
        commands.push(args);
        if (args[0] === 'db' && args[1] === 'path') return database;
        if (args[0] === 'db') return JSON.stringify([row]);
        if (args[0] === 'session' && args[1] === 'delete') {
          if (failDelete) throw new Error('Synthetic deletion failure');
          row = { ...empty(), events: residue ? 1 : 0 };
          return 'deleted';
        }
        throw new Error('Unexpected native request');
      }),
      waitForExit: vi.fn(async () => {}),
    };
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); });

  it('launches cleanup from durable home after the task checkout is reclaimed', async () => {
    const target = await capture();
    await fs.rm(cwd, { recursive: true });
    const maintenance = vi.fn((command, directory, environment) => {
      expect(command).toBe(target.command);
      expect(directory).toBe(home);
      expect(environment.OPENCODE_DB).toBe(database);
      return transport;
    });
    expect((await deleteOwnedOpenCodeSession(target, recovery(), maintenance)).state).toBe('deleted');
    expect(maintenance).toHaveBeenCalledOnce();
  });

  it('captures exact metadata then prepares before permanent deletion and verifies all history absent', async () => {
    const target = await capture();
    expect(validOpenCodeDeletionTarget(target)).toBe(true);
    commands.length = 0;
    const state = recovery();
    const run = transport.run;
    transport.run = async args => {
      if (args[0] === 'session') expect(state.persistPrepared).toHaveBeenCalledWith(openCodeDeletionPreparation(target));
      return run(args);
    };
    expect((await deleteOwnedOpenCodeSession(target, state, factory)).state).toBe('deleted');
    expect(commands.filter(args => args[0] === 'session')).toEqual([['session', 'delete', id]]);
    expect(commands.filter(args => args[0] === 'db' && args[1] !== 'path').every(args =>
      args[1].startsWith('SELECT ') && args[1].includes(`WHERE id='${id}'`) && !args[1].includes('SELECT data'))).toBe(true);
    expect(state.persistMaintenanceState.mock.calls).toEqual([[true], [false]]);
    expect(transport.waitForExit).toHaveBeenCalledTimes(2);
  });

  it.each(['children', 'parentId', 'cwd', 'projectId', 'createdAt'])('holds changed %s metadata without recursive deletion', async field => {
    const target = await capture();
    row[field] = field === 'children' ? 1 : field === 'createdAt' ? 999 : 'changed';
    expect((await deleteOwnedOpenCodeSession(target, recovery(), factory)).state).toBe('held');
    expect(commands.some(args => args[0] === 'session')).toBe(false);
  });

  it('holds another pointer to the exact target but permits unrelated valid pointers', async () => {
    const target = await capture();
    const other = path.join(path.dirname(pointer), 'other.json');
    await fs.writeFile(other, JSON.stringify({ id: 'ses_unrelated' }));
    await fs.writeFile(path.join(path.dirname(pointer), 'main.json'), JSON.stringify({ id }));
    expect((await deleteOwnedOpenCodeSession(target, recovery(), factory)).state).toBe('held');
    await fs.unlink(path.join(path.dirname(pointer), 'main.json'));
    expect((await deleteOwnedOpenCodeSession(target, recovery(), factory)).state).toBe('deleted');
    expect(JSON.parse(await fs.readFile(other, 'utf8')).id).toBe('ses_unrelated');
    expect(await fs.readFile(database, 'utf8')).toBe('synthetic database identity');
  });

  it('requires durable preparation for an already absent target and retains orphaned events', async () => {
    const target = await capture();
    row = empty();
    expect((await deleteOwnedOpenCodeSession(target, recovery(), factory)).state).toBe('held');
    const state = { ...recovery(), prepared: openCodeDeletionPreparation(target) };
    expect((await deleteOwnedOpenCodeSession(target, state, factory)).state).toBe('deleted');
    row.events = 1;
    expect((await deleteOwnedOpenCodeSession(target, state, factory)).state).toBe('held');
    expect(commands.some(args => args[0] === 'session')).toBe(false);
  });

  it.each([true, false])('retains uncertain deletion outcome (native failure: %s)', async failure => {
    const target = await capture();
    failDelete = failure;
    residue = !failure;
    expect((await deleteOwnedOpenCodeSession(target, recovery(), factory)).state).toBe('uncertain');
  });

  it('requires durable fencing and matching preparation before constructing a maintenance writer', async () => {
    const target = await capture();
    const create = vi.fn(factory);
    expect((await deleteOwnedOpenCodeSession(target, {}, create)).state).toBe('held');
    expect((await deleteOwnedOpenCodeSession(target, { ...recovery(), prepared: {
      ...openCodeDeletionPreparation(target), targetHash: 'changed',
    } }, create)).state).toBe('held');
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the maintenance fence when process-group exit cannot be proved', async () => {
    const target = await capture();
    transport.waitForExit = vi.fn(async () => { throw new Error('Synthetic exit uncertainty'); });
    const state = recovery();
    expect((await deleteOwnedOpenCodeSession(target, state, factory)).state).toBe('uncertain');
    expect(state.persistMaintenanceState.mock.calls).toEqual([[true]]);
  });

  it('permits a detached old pointer only with exact native identity and reset preparation', async () => {
    const target = await capture();
    await fs.writeFile(pointer, JSON.stringify({ id: 'ses_newgeneration', cwd }));
    expect((await deleteOwnedOpenCodeSession(target, recovery(), factory)).state).toBe('held');
    expect((await deleteOwnedOpenCodeSession(target, { ...recovery(), detachedPointer: true }, factory)).state).toBe('deleted');
    expect(JSON.parse(await fs.readFile(pointer, 'utf8')).id).toBe('ses_newgeneration');
  });

  it('rejects replaced storage and malformed metadata without invoking native deletion', async () => {
    const target = await capture();
    await fs.rename(database, `${database}.old`);
    await fs.writeFile(database, 'replacement');
    expect((await deleteOwnedOpenCodeSession(target, recovery(), factory)).state).toBe('held');
    await fs.unlink(database);
    await fs.rename(`${database}.old`, database);
    row.events = '0';
    expect((await deleteOwnedOpenCodeSession(target, recovery(), factory)).state).toBe('held');
    expect(commands.some(args => args[0] === 'session')).toBe(false);
  });

  it('fails closed on unsupported platforms before launching maintenance', async () => {
    const target = await capture();
    const create = vi.fn(factory);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect((await deleteOwnedOpenCodeSession(target, recovery(), create)).state).toBe('unsupported');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects injection and direct-thread identities before storage access', () => {
    expect(validOpenCodeDeletionTarget({ sessionId: "ses_x'; DELETE FROM session;--" })).toBe(false);
    expect(validOpenCodeDeletionTarget({ version: 1, backend: 'opencode', sessionId: id,
      executorThreadId: 'main-thread' } as OpenCodeDeletionTarget)).toBe(false);
  });
});
