import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { spawn } from 'child_process';

vi.mock('child_process');
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    promises: {
      unlink: vi.fn()
    }
  }
}));
vi.mock('os');

describe('ClaudePersistentExecutor - multimodal', () => {
  let executor: ClaudePersistentExecutor;
  let mockProcess: any;
  let writeMock: any;

  beforeEach(() => {
    const mockGuard = {
      resolveWorkingDirectory: vi.fn().mockReturnValue('/mock/dir'),
      isAllowed: vi.fn().mockReturnValue(true),
    } as unknown as DirectoryGuard;

    writeMock = vi.fn();
    mockProcess = {
      pid: 12345,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { write: writeMock, end: vi.fn() },
      on: vi.fn((event, cb) => {
        if (event === 'close') {
          mockProcess._closeCallback = cb;
        } else if (event === 'error') {
          // allow setting error listener
        }
      }),
      once: vi.fn((event, cb) => {
        if (event === 'error') {
          // Do not trigger early error immediately, let start process finish
        }
      }),
      removeListener: vi.fn(),
      kill: vi.fn(),
    };

    (spawn as any).mockReturnValue(mockProcess);

    executor = new ClaudePersistentExecutor(mockGuard, '/mock/dir');
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should format text and image attachments into an array of blocks', async () => {
    const executePromise = executor.execute('Look at this', {
      attachments: [{
        type: 'image',
        data: 'base64data',
        mimeType: 'image/png'
      }]
    });

    // Advance past startProcess earlyError timer
    await vi.advanceTimersByTimeAsync(1100);

    expect(writeMock).toHaveBeenCalled();
    const writeCall = writeMock.mock.calls[0][0];
    const parsed = JSON.parse(writeCall);
    
    expect(parsed.message.content).toBeInstanceOf(Array);
    expect(parsed.message.content).toHaveLength(2);
    expect(parsed.message.content[0]).toEqual({ type: 'text', text: 'Look at this' });
    expect(parsed.message.content[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'base64data'
      }
    });

    // Need to resolve the promise so executor is not left hanging
    if (mockProcess._closeCallback) mockProcess._closeCallback(0);
    // Suppress reject error caused by process exit during execute
    try { await executePromise; } catch (e) {}
  });

  it('should fallback to empty string when no prompt but no image is provided', async () => {
    const executePromise = executor.execute('', {
      attachments: []
    });

    await vi.advanceTimersByTimeAsync(1100);

    expect(writeMock).toHaveBeenCalled();
    const writeCall = writeMock.mock.calls[0][0];
    const parsed = JSON.parse(writeCall);
    
    expect(parsed.message.content).toBe('');

    if (mockProcess._closeCallback) mockProcess._closeCallback(0);
    try { await executePromise; } catch (e) {}
  });
  
  it('should process standalone image prompts correctly', async () => {
    const executePromise = executor.execute('', {
      attachments: [{
        type: 'image',
        data: 'base64data2',
        mimeType: 'image/jpeg'
      }]
    });

    await vi.advanceTimersByTimeAsync(1100);

    expect(writeMock).toHaveBeenCalled();
    const writeCall = writeMock.mock.calls[0][0];
    const parsed = JSON.parse(writeCall);
    
    expect(parsed.message.content).toBeInstanceOf(Array);
    expect(parsed.message.content).toHaveLength(1);
    expect(parsed.message.content[0]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: 'base64data2'
      }
    });

    if (mockProcess._closeCallback) mockProcess._closeCallback(0);
    try { await executePromise; } catch (e) {}
  });
});
