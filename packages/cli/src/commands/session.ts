import { ConfigManager } from '../config/ConfigManager';
import { ThreadManager } from '../thread/ThreadManager';
import { formatLocalSessionInfo, readLocalSessionInfo } from '../session/SessionLocalInfo';
import { SESSION_BACKENDS } from '../session/SessionResumeService';
import type { BackendKey } from '../types/config';

export interface SessionShowOptions {
  /** Remote thread name, as shown by `/thread list`. */
  thread: string;
  /** Stable backend key. */
  backend: string;
}

export interface SessionShowResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Read-only local session inspection. Works without a running daemon, never
 * starts a backend, and keeps exact native locators on this computer.
 */
export async function sessionShowCommand(options: SessionShowOptions): Promise<SessionShowResult> {
  if (!SESSION_BACKENDS.includes(options.backend as BackendKey)) {
    return { success: false, error: `Unknown backend "${options.backend}". Expected one of: ${SESSION_BACKENDS.join(', ')}.` };
  }
  try {
    const config = await ConfigManager.initialize();
    const threads = await ThreadManager.initialize();
    const thread = threads.getThreadByName(options.thread);
    if (!thread) {
      return { success: false, error: `Thread "${options.thread}" was not found. Run /thread list in Feishu to see thread names.` };
    }
    const info = readLocalSessionInfo({
      threadId: thread.id,
      threadName: thread.name,
      workingDirectory: thread.workingDirectory,
      backend: options.backend as BackendKey,
      home: undefined,
      remoteCliDirectory: config.getConfigDir(),
    });
    return { success: true, output: formatLocalSessionInfo(info) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Session inspection failed.' };
  }
}
