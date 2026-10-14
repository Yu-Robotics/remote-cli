import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/config/ConfigManager');
vi.mock('../../src/thread/ThreadManager');

import { ConfigManager } from '../../src/config/ConfigManager';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { sessionShowCommand } from '../../src/commands/session';

describe('session show command', () => {
  let home: string;
  let workspace: string;
  const threadId = 'default-id';

  beforeEach(() => {
    vi.clearAllMocks();
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-show-test-')));
    workspace = path.join(home, 'workspace');
    fs.mkdirSync(workspace);
    (ConfigManager.initialize as any) = vi.fn().mockResolvedValue({
      getConfigDir: () => path.join(home, '.remote-cli'),
    });
    (ThreadManager.initialize as any) = vi.fn().mockResolvedValue({
      getThreadByName: (name: string) => name === 'default'
        ? { id: threadId, name: 'default', workingDirectory: workspace }
        : undefined,
    });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('prints local-only guidance for a recorded session', async () => {
    const directory = path.join(home, '.remote-cli', 'pi-sessions');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${threadId}.json`), JSON.stringify({ id: 'pi-native', cwd: workspace }), { mode: 0o600 });
    const result = await sessionShowCommand({ thread: 'default', backend: 'pi' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('pi --session pi-native');
    expect(result.output).toContain('pi-sessions/default-id.json');
  });

  it('reports missing history and unknown threads explicitly', async () => {
    const missing = await sessionShowCommand({ thread: 'default', backend: 'pi' });
    expect(missing.success).toBe(true);
    expect(missing.output).toContain('No persisted session pointer');
    const unknownThread = await sessionShowCommand({ thread: 'nope', backend: 'pi' });
    expect(unknownThread.success).toBe(false);
    expect(unknownThread.error).toContain('was not found');
  });

  it('rejects an unknown backend without touching any pointer', async () => {
    const result = await sessionShowCommand({ thread: 'default', backend: 'not-a-backend' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown backend');
    expect(ThreadManager.initialize).not.toHaveBeenCalled();
  });

  it('reports a non-Error initialization failure with a generic message', async () => {
    (ConfigManager.initialize as any) = vi.fn().mockRejectedValue('synthetic failure');
    const result = await sessionShowCommand({ thread: 'default', backend: 'pi' });
    expect(result).toMatchObject({ success: false, error: 'Session inspection failed.' });
  });

  it('surfaces an initialization failure instead of a false success', async () => {
    (ConfigManager.initialize as any) = vi.fn().mockRejectedValue(new Error('config unreadable'));
    const result = await sessionShowCommand({ thread: 'default', backend: 'pi' });
    expect(result).toMatchObject({ success: false, error: 'config unreadable' });
  });
});
