import { spawn } from 'child_process';
import { DirectoryGuard } from '../security/DirectoryGuard';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Get Claude's global sessions directory
 */
function getClaudeSessionsDir(): string | null {
  const homeDir = os.homedir();
  const possiblePaths = [
    path.join(homeDir, '.claude', 'sessions'),
    path.join(homeDir, '.config', 'claude', 'sessions'),
    path.join(homeDir, 'Library', 'Application Support', 'Claude', 'sessions'),
  ];

  for (const dir of possiblePaths) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return null;
}

/**
 * Claude execution options
 */
export interface ClaudeExecuteOptions {
  /** Stream output callback */
  onStream?: (chunk: string) => void;
  /** Execution timeout (milliseconds), default 300000 (5 minutes) */
  timeout?: number;
}

/**
 * Claude execution result
 */
export interface ClaudeExecuteResult {
  /** Whether execution was successful */
  success: boolean;
  /** Output content */
  output?: string;
  /** Error message */
  error?: string;
}

/**
 * Session info from Claude Code
 */
interface SessionInfo {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Claude Executor
 * Manages session ID for continuity using --resume
 */
export class ClaudeExecutor {
  private directoryGuard: DirectoryGuard;
  private currentWorkingDirectory: string;
  private isExecuting = false;
  private isDestroyed = false;
  private defaultTimeout = 300000; // 5 minutes
  private sessionId: string | null = null;
  private sessionFilePath: string;

  constructor(directoryGuard: DirectoryGuard) {
    this.directoryGuard = directoryGuard;
    this.currentWorkingDirectory = process.cwd();
    // Store session ID in a file in the working directory
    this.sessionFilePath = path.join(this.currentWorkingDirectory, '.claude-session');
    this.loadSessionId();
  }

  /**
   * Load session ID from file if exists
   */
  private loadSessionId(): void {
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        const data = fs.readFileSync(this.sessionFilePath, 'utf-8');
        const session = JSON.parse(data);
        if (session.id) {
          this.sessionId = session.id;
          console.log(`[Claude] Loaded session ID: ${this.sessionId}`);
        }
      }
    } catch (error) {
      console.error('[Claude] Failed to load session ID:', error);
      this.sessionId = null;
    }
  }

  /**
   * Save session ID to file
   */
  private saveSessionId(sessionId: string): void {
    try {
      const data = JSON.stringify({
        id: sessionId,
        savedAt: new Date().toISOString(),
      });
      fs.writeFileSync(this.sessionFilePath, data, 'utf-8');
      console.log(`[Claude] Saved session ID: ${sessionId}`);
    } catch (error) {
      console.error('[Claude] Failed to save session ID:', error);
    }
  }

  /**
   * Get recent session ID from Claude's sessions directory
   * Finds the most recently modified session file
   */
  private async getRecentSessionId(): Promise<string | null> {
    try {
      const sessionsDir = getClaudeSessionsDir();
      if (!sessionsDir) {
        console.log('[Claude] No sessions directory found');
        return null;
      }

      // List all session directories
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      const sessionDirs = entries
        .filter(entry => entry.isDirectory())
        .map(entry => {
          const sessionPath = path.join(sessionsDir, entry.name);
          const stats = fs.statSync(sessionPath);
          return {
            id: entry.name,
            mtime: stats.mtime,
          };
        })
        .filter(session => {
          // Validate UUID format
          const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          return uuidPattern.test(session.id);
        })
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      if (sessionDirs.length === 0) {
        console.log('[Claude] No sessions found in directory');
        return null;
      }

      // Return the most recent session ID
      const recentSession = sessionDirs[0];
      console.log(`[Claude] Found recent session: ${recentSession.id} (last modified: ${recentSession.mtime.toISOString()})`);
      return recentSession.id;
    } catch (error) {
      console.error('[Claude] Failed to get recent session ID:', error);
      return null;
    }
  }

  /**
   * Get current working directory
   */
  getCurrentWorkingDirectory(): string {
    return this.currentWorkingDirectory;
  }

  /**
   * Set working directory
   * @param targetPath Target path
   * @throws If path is not safe
   */
  async setWorkingDirectory(targetPath: string): Promise<void> {
    const resolvedPath = this.directoryGuard.resolveWorkingDirectory(
      targetPath,
      this.currentWorkingDirectory
    );

    this.currentWorkingDirectory = resolvedPath;
    // Update session file path
    this.sessionFilePath = path.join(this.currentWorkingDirectory, '.claude-session');
    this.loadSessionId();
  }

  /**
   * Execute Claude command
   * @param prompt Command prompt
   * @param options Execution options
   * @returns Execution result
   */
  async execute(
    prompt: string,
    options: ClaudeExecuteOptions = {}
  ): Promise<ClaudeExecuteResult> {
    if (this.isDestroyed) {
      return {
        success: false,
        error: 'Executor has been destroyed',
      };
    }

    if (this.isExecuting) {
      return {
        success: false,
        error: 'Executor is busy, please wait for current task to complete. Send the abort command to cancel the running task.',
      };
    }

    this.isExecuting = true;

    try {
      // Only use timeout if explicitly provided in options
      // Default timeout is disabled to prevent premature termination of long-running tasks
      // Users can cancel with /abort if needed
      const timeout = options.timeout; // undefined means no timeout

      // If we don't have a session ID, try to get recent one from Claude's sessions directory
      if (!this.sessionId) {
        console.log('[Claude] No session ID, checking for recent sessions...');
        this.sessionId = await this.getRecentSessionId();
        if (this.sessionId) {
          this.saveSessionId(this.sessionId);
        }
      }

      const result = await this.executeWithClaudeCLI(prompt, options, timeout);
      return result;
    } catch (error) {
      return {
        success: false,
        error: this.formatError(error),
      };
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Execute using local Claude Code CLI
   */
  private async executeWithClaudeCLI(
    prompt: string,
    options: ClaudeExecuteOptions,
    timeout: number | undefined
  ): Promise<ClaudeExecuteResult> {
    return new Promise((resolve, reject) => {
      const outputChunks: string[] = [];
      let timeoutTimer: NodeJS.Timeout | undefined;

      // Verify working directory exists
      if (!fs.existsSync(this.currentWorkingDirectory)) {
        reject(new Error(`Working directory does not exist: ${this.currentWorkingDirectory}`));
        return;
      }

      // Build claude command arguments
      const args: string[] = ['--print'];

      if (this.sessionId) {
        args.push('--resume', this.sessionId);
        console.log(`[Claude] Resuming session: ${this.sessionId}`);
      } else {
        console.log('[Claude] Starting new session');
      }

      args.push(prompt);

      console.log(`[Claude] Starting: claude ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);
      console.log(`[Claude] Working directory: ${this.currentWorkingDirectory}`);

      const child = spawn('claude', args, {
        cwd: this.currentWorkingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CI: 'true',
          FORCE_COLOR: '0',
        },
      });

      console.log(`[Claude] Process started with PID: ${child.pid}`);

      // Handle stdout
      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        console.log('[Claude stdout]', chunk);
        outputChunks.push(chunk);
        if (options.onStream) {
          try {
            options.onStream(chunk);
          } catch (error) {
            console.error('[Claude] onStream callback error:', error);
          }
        }
      });

      // Handle stderr
      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        console.error('[Claude stderr]', chunk);
        outputChunks.push(chunk);
        if (options.onStream) {
          try {
            options.onStream(chunk);
          } catch (error) {
            console.error('[Claude] onStream callback error:', error);
          }
        }
      });

      // Handle timeout (only if explicitly provided)
      // Default timeout is disabled to prevent premature termination
      if (timeout !== undefined) {
        timeoutTimer = setTimeout(() => {
          console.error('[Claude] Command timeout');
          child.kill('SIGTERM');
          reject(new Error('Execution timeout exceeded'));
        }, timeout);
      }

      // Handle process completion
      child.on('close', (code) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        console.log(`[Claude] Process exited with code: ${code}`);

        const output = outputChunks.join('');

        // Check if session ID is in output (for new sessions)
        if (!this.sessionId) {
          const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
          const matches = output.match(uuidPattern);
          if (matches && matches.length > 0) {
            this.sessionId = matches[0];
            this.saveSessionId(this.sessionId);
            console.log(`[Claude] New session ID: ${this.sessionId}`);
          }
        }

        if (code === 0) {
          console.log('[Claude] Execution completed successfully');
          resolve({
            success: true,
            output: output.trim(),
          });
        } else {
          console.error(`[Claude] Execution failed with code ${code}`);
          resolve({
            success: false,
            error: `Claude Code process exited with code ${code}${output ? '\n' + output : ''}`,
          });
        }
      });

      // Handle process errors
      child.on('error', (error) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        console.error('[Claude] Process error:', error);

        if (error.message.includes('ENOENT')) {
          reject(new Error(
            'Claude Code CLI not found. Please ensure Claude Code is installed and available in PATH.\n' +
            'Installation: https://docs.anthropic.com/en/docs/claude-code/installation'
          ));
        } else {
          reject(error);
        }
      });
    });
  }

  /**
   * Format error message
   */
  private formatError(error: unknown): string {
    if (error instanceof Error) {
      if (error.message.includes('timeout')) {
        return `Execution timeout exceeded. The task took too long to complete.`;
      }
      if (error.message.includes('ENOENT')) {
        return `Claude Code CLI not found. Please ensure it's installed and available in PATH.`;
      }
      if (error.message.includes('EACCES') || error.message.includes('Permission denied')) {
        return `Permission denied. You may not have access to this resource.`;
      }
      return `Execution error: ${error.message}`;
    }
    return 'Unknown execution error';
  }

  /**
   * Reset execution context
   * Clears the session ID so next command starts a new session
   */
  resetContext(): void {
    console.log('[Claude] Resetting session context');
    this.sessionId = null;

    // Remove session file
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        fs.unlinkSync(this.sessionFilePath);
        console.log('[Claude] Session file removed');
      }
    } catch (error) {
      console.error('[Claude] Failed to remove session file:', error);
    }
  }

  /**
   * Abort current command execution
   * For ClaudeExecutor, this just resets the executing flag since
   * each command spawns a new process and cannot be easily aborted mid-execution
   */
  async abort(): Promise<boolean> {
    if (!this.isExecuting) {
      console.log('[Claude] No command is currently executing');
      return false;
    }

    console.log('[Claude] Abort requested, but spawn-mode executor cannot abort running command');
    // Note: Since this executor spawns a new process for each command,
    // we cannot easily abort it. We just reset the flag so the next
    // command can be processed (the current one will complete in background).
    this.isExecuting = false;
    return true;
  }

  /**
   * Destroy executor
   */
  destroy(): void {
    this.isDestroyed = true;
    this.isExecuting = false;
  }

  /**
   * Generate a new session ID (UUID v4)
   */
  private generateSessionId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
