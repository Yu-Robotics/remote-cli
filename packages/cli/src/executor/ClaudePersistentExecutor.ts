import { spawn, ChildProcess } from 'child_process';
import { DirectoryGuard } from '../security/DirectoryGuard';
import { claudeCodeHooks } from '../hooks/ClaudeCodeHooks';
import { StructuredContent, ContentBlockUnion, ToolUseInfo, ToolResultInfo } from '../types';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

/**
 * Claude stream JSON input message
 * Note: stream-json format expects 'type' at top level with nested 'message' object
 * Format: { "type": "user", "message": { "role": "user", "content": "..." } }
 */
interface ClaudeInputMessage {
  /** Message type */
  type: 'user';
  /** Message object with role and content */
  message: {
    /** Role of the message sender */
    role: 'user';
    /** Message content */
    content: string;
  };
}

/**
 * Claude stream JSON output message
 */
/**
 * Content block in assistant message
 */
interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  is_error?: boolean;
}

interface ClaudeOutputMessage {
  /** Message type */
  type: 'message' | 'thinking' | 'error' | 'usage' | 'system' | 'stream_event' | 'result' | 'assistant' | 'user';
  /** Message content (string or array of content blocks) */
  content?: string | ContentBlock[];
  /** Nested message object (for assistant type with full message structure) */
  message?: {
    role: string;
    content?: ContentBlock[];
    stop_reason?: string | null;
  };
  /** Whether this is a partial chunk */
  partial?: boolean;
  /** Usage information */
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  /** Message subtype - varies by type: 'init' for system, 'success'/'error' for result */
  subtype?: 'init' | 'success' | 'error';
  /** Current working directory (for system/init) */
  cwd?: string;
  /** Session ID (for system/init) */
  session_id?: string;
  /** Stream event details (for stream_event) */
  event?: {
    type: string;
    index?: number;
    content_block?: {
      type: string;
      text?: string;
    };
  };
  /** Parent tool use ID */
  parent_tool_use_id?: string | null;
  /** Message UUID */
  uuid?: string;
  /** Result content (for result messages) */
  result?: string;
  /** Error flag (for result messages) */
  is_error?: boolean;
  /** Duration in milliseconds (for result messages) */
  duration_ms?: number;
}

/**
 * Persistent Claude Executor options
 */
export interface PersistentClaudeOptions {
  /** Stream output callback (for backward compatibility) */
  onStream?: (chunk: string) => void;
  /** Structured content callback (for rich formatting) */
  onStructuredContent?: (content: StructuredContent) => void;
  /** Tool use callback (for rich formatting) */
  onToolUse?: (toolUse: ToolUseInfo) => void;
  /** Tool result callback (for rich formatting) */
  onToolResult?: (toolResult: ToolResultInfo) => void;
  /** Execution timeout (milliseconds), default 300000 (5 minutes) */
  timeout?: number;
}

/**
 * Persistent Claude execution result
 */
export interface PersistentClaudeResult {
  /** Whether execution was successful */
  success: boolean;
  /** Complete output content */
  output?: string;
  /** Error message */
  error?: string;
  /** Session ID abbreviation (last 8 chars) */
  sessionAbbr?: string;
}

/**
 * Claude Persistent Executor
 *
 * Maintains a long-running Claude process and communicates via stdin/stdout
 * using stream-json format for real-time bidirectional communication.
 */
export class ClaudePersistentExecutor extends EventEmitter {
  private directoryGuard: DirectoryGuard;
  private currentWorkingDirectory: string;
  private isDestroyed = false;
  private defaultTimeout = 600000; // 10 minutes default, but will extend on activity
  private sessionId: string | null = null;
  private sessionFilePath: string;

  // Persistent process
  private claudeProcess: ChildProcess | null = null;
  private isStarting = false;
  private isStopping = false; // Flag to indicate intentional process stop
  private commandQueue: Array<{
    prompt: string;
    options: PersistentClaudeOptions;
    resolve: (result: PersistentClaudeResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private isProcessing = false;

  // Output handling
  private currentOutputBuffer: string[] = [];
  private currentStreamCallback?: (chunk: string) => void;
  private currentToolUseCallback?: (toolUse: ToolUseInfo) => void;
  private currentToolResultCallback?: (toolResult: ToolResultInfo) => void;
  private currentCommandResolve?: (result: PersistentClaudeResult) => void;
  private currentCommandReject?: (error: Error) => void;
  private currentTimeoutTimer?: NodeJS.Timeout;

  // Structured content collection for rich formatting
  private structuredContentBlocks: ContentBlockUnion[] = [];
  private currentStructuredCallback?: (content: StructuredContent) => void;

  // Current task context for hooks
  private currentTaskId: string | null = null;
  private currentTaskStartTime: number = 0;

  // Interactive input handling
  private isWaitingForInput = false;
  private inputRequestCallbacks: Array<(input: string) => void> = [];
  private inputDetectionTimer?: NodeJS.Timeout;
  private lastOutputTime = 0;

  // Activity tracking for timeout extension (optional, can be disabled)
  private activityTrackingEnabled = false;

  constructor(directoryGuard: DirectoryGuard, initialWorkingDirectory?: string) {
    super();
    this.directoryGuard = directoryGuard;
    // Use provided working directory or fall back to process.cwd()
    // If a working directory is provided, validate it first
    if (initialWorkingDirectory) {
      try {
        this.currentWorkingDirectory = this.directoryGuard.resolveWorkingDirectory(
          initialWorkingDirectory,
          process.cwd()
        );
      } catch (error) {
        // If validation fails, fall back to process.cwd()
        console.warn(`[ClaudePersistent] Failed to use initial working directory: ${initialWorkingDirectory}`, error);
        this.currentWorkingDirectory = process.cwd();
      }
    } else {
      this.currentWorkingDirectory = process.cwd();
    }
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
          console.log(`[ClaudePersistent] Loaded session ID: ${this.sessionId}`);
        }
      }
    } catch (error) {
      console.error('[ClaudePersistent] Failed to load session ID:', error);
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
      console.log(`[ClaudePersistent] Saved session ID: ${sessionId}`);
    } catch (error) {
      console.error('[ClaudePersistent] Failed to save session ID:', error);
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
   *
   * When working directory changes, we start a fresh session without inheriting
   * the previous session. This prevents session conflicts when switching between
   * directories that may have their own .claude-session files.
   */
  async setWorkingDirectory(targetPath: string): Promise<void> {
    const resolvedPath = this.directoryGuard.resolveWorkingDirectory(
      targetPath,
      this.currentWorkingDirectory
    );

    // If directory changes, we need to restart the process with a fresh session
    const needsRestart = this.currentWorkingDirectory !== resolvedPath && this.claudeProcess !== null;

    this.currentWorkingDirectory = resolvedPath;
    this.sessionFilePath = path.join(this.currentWorkingDirectory, '.claude-session');

    // Start fresh session when changing directories - don't inherit previous session
    // This prevents errors when switching to a directory with old session files
    this.sessionId = null;
    console.log('[ClaudePersistent] Working directory changed, starting fresh session (no session inheritance)');

    if (needsRestart) {
      console.log('[ClaudePersistent] Restarting process in new directory...');
      await this.stopProcess();
      await this.startProcess();
    }
  }

  /**
   * Start the persistent Claude process
   */
  private async startProcess(): Promise<void> {
    if (this.claudeProcess || this.isStarting) {
      return;
    }

    this.isStarting = true;

    try {
      // Verify working directory exists
      if (!fs.existsSync(this.currentWorkingDirectory)) {
        throw new Error(`Working directory does not exist: ${this.currentWorkingDirectory}`);
      }

      // Build arguments
      // Note: --output-format=stream-json requires --verbose
      const args: string[] = [
        '--input-format=stream-json',
        '--output-format=stream-json',
        '--include-partial-messages',
        '--verbose',
        '--dangerously-skip-permissions'
      ];

      if (this.sessionId) {
        args.push('--resume', this.sessionId);
        console.log(`[ClaudePersistent] Resuming session: ${this.sessionId}`);
      } else {
        console.log('[ClaudePersistent] Starting new session');
      }

      console.log(`[ClaudePersistent] Starting: claude ${args.join(' ')}`);
      console.log(`[ClaudePersistent] Working directory: ${this.currentWorkingDirectory}`);

      // Spawn the process
      const child = spawn('claude', args, {
        cwd: this.currentWorkingDirectory,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          // Prevent nested session error
          CLAUDECODE: '',
        },
      });

      this.claudeProcess = child;

      // Buffer for collecting stderr on startup (for error reporting)
      let stderrBuffer: string[] = [];
      let isStartupPhase = true;

      // Handle stdout (JSON stream)
      let buffer = '';
      child.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();

        // Process complete JSON lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            this.handleOutputLine(line.trim());
          }
        }
      });

      // Handle stderr
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();

        // Collect stderr during startup for error reporting
        if (isStartupPhase) {
          stderrBuffer.push(text);
          // Keep only last 20 lines to avoid memory issues
          if (stderrBuffer.length > 20) {
            stderrBuffer.shift();
          }
        }

        console.error('[ClaudePersistent stderr]', text);

        // Forward to current stream callback if available
        if (this.currentStreamCallback) {
          this.currentStreamCallback(text);
        }
        this.currentOutputBuffer.push(text);
      });

      // Handle process exit
      child.on('exit', (code, signal) => {
        isStartupPhase = false;
        const stderrOutput = stderrBuffer.join('');
        stderrBuffer = []; // Clear buffer

        if (code !== 0 && code !== null) {
          console.error(`[ClaudePersistent] Process exited with code ${code}, signal ${signal}`);
          if (stderrOutput) {
            console.error('[ClaudePersistent] stderr output:\n', stderrOutput);
          }
        } else {
          console.log(`[ClaudePersistent] Process exited with code ${code}, signal ${signal}`);
        }

        this.claudeProcess = null;

        // Check if this was an intentional stop (abort/reset)
        const wasIntentionalStop = this.isStopping;
        this.isStopping = false; // Reset the flag

        // Reject current command if any (only for unexpected exits)
        if (this.currentCommandReject && !wasIntentionalStop) {
          let errorMsg = `Claude process exited unexpectedly (code: ${code})`;
          if (stderrOutput) {
            errorMsg += `\nstderr: ${stderrOutput.substring(0, 500)}`;
          }
          this.currentCommandReject(new Error(errorMsg));
          this.resetCurrentCommand();
        }

        // Emit event for external handling
        this.emit('processExit', { code, signal, intentional: wasIntentionalStop });

        // Auto-restart if not destroyed and there are pending commands
        // Don't auto-restart if this was an intentional stop (let processQueue handle it)
        if (!this.isDestroyed && !wasIntentionalStop && this.commandQueue.length > 0) {
          console.log('[ClaudePersistent] Auto-restarting process...');
          setTimeout(() => this.startProcess(), 1000);
        }
      });

      // Handle process error
      child.on('error', (error) => {
        console.error('[ClaudePersistent] Process error:', error);
        this.claudeProcess = null;
        this.isStarting = false;

        if (this.currentCommandReject) {
          if (error.message.includes('ENOENT')) {
            this.currentCommandReject(new Error(
              'Claude Code CLI not found. Please ensure Claude Code is installed and available in PATH.'
            ));
          } else {
            this.currentCommandReject(error);
          }
          this.resetCurrentCommand();
        }
      });

      // Wait a bit for process to be ready
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Clear startup phase after a few seconds (stderr won't be buffered anymore)
      setTimeout(() => {
        isStartupPhase = false;
        stderrBuffer = [];
      }, 5000);

      console.log(`[ClaudePersistent] Process started with PID: ${child.pid}`);
      this.isStarting = false;

      // Process any pending commands
      this.processQueue();

    } catch (error) {
      this.isStarting = false;
      throw error;
    }
  }

  /**
   * Stop the persistent Claude process
   */
  private async stopProcess(): Promise<void> {
    if (!this.claudeProcess) {
      return;
    }

    console.log('[ClaudePersistent] Stopping process...');
    this.isStopping = true;

    // Send EOF to stdin to gracefully close
    this.claudeProcess.stdin?.end();

    // Kill after timeout
    const killTimeout = setTimeout(() => {
      if (this.claudeProcess) {
        console.log('[ClaudePersistent] Force killing process...');
        this.claudeProcess.kill('SIGTERM');
      }
    }, 5000);

    // Wait for process to exit
    await new Promise<void>(resolve => {
      if (!this.claudeProcess) {
        resolve();
        return;
      }

      this.claudeProcess.on('exit', () => {
        clearTimeout(killTimeout);
        resolve();
      });
    });

    this.claudeProcess = null;
    console.log('[ClaudePersistent] Process stopped');
  }

  /**
   * Reset the command timeout timer when activity is detected
   * This prevents timeout during long-running tasks with continuous output
   *
   * NOTE: This method is currently disabled because inactivity timeout can cause
   * state inconsistency - the executor may timeout while Claude process is still
   * running, leading to confusing behavior where user sees timeout error but
   * Claude is still working. Users can use /abort to cancel long-running tasks.
   */
  private resetActivityTimeout(): void {
    // Activity-based timeout is disabled to prevent state inconsistency.
    // If a command hangs, users can manually abort with /abort.
    if (!this.activityTrackingEnabled) {
      return;
    }

    if (!this.isProcessing || !this.currentTimeoutTimer) {
      return;
    }

    // Clear existing timer and set a new one
    clearTimeout(this.currentTimeoutTimer);
    this.currentTimeoutTimer = setTimeout(() => {
      console.error('[ClaudePersistent] Command timeout due to inactivity');
      this.completeCurrentCommand(false, 'Execution timeout: No response from Claude for 10 minutes');
    }, this.defaultTimeout);
  }

  /**
   * Handle a line of JSON output from Claude
   */
  private handleOutputLine(line: string): void {
    try {
      // Parse message first to check type
      const parsedMessage: ClaudeOutputMessage = JSON.parse(line);

      // Skip logging for stream_event messages to avoid console spam
      // These are internal protocol messages (content_block_start, content_block_delta, etc.)
      if (parsedMessage.type !== 'stream_event') {
        const timestamp = new Date().toISOString();
        console.log(`[ClaudePersistent RAW ${timestamp}] ${line}`);
      }

      const message: ClaudeOutputMessage = parsedMessage;

      // Reset timeout on any activity to prevent timeout during long tasks
      this.resetActivityTimeout();

      switch (message.type) {
        case 'message':
        case 'thinking':
          const contentLength = typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length;
          console.log(`[ClaudePersistent] Received ${message.type} message, partial=${message.partial}, content length=${contentLength}`);
          if (message.content) {
            const contentStr = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
            this.currentOutputBuffer.push(contentStr);
            if (this.currentStreamCallback) {
              this.currentStreamCallback(contentStr);
            }

            // Note: Don't complete on partial=false here
            // The command completion should be handled by the 'result' message
            // which is the definitive end-of-response signal
          }
          break;

        case 'error':
          console.error('[ClaudePersistent] Error from Claude:', message.content);
          this.completeCurrentCommand(false, typeof message.content === 'string' ? message.content : 'Unknown error from Claude');
          break;

        case 'usage':
          // Usage info, can be logged or ignored
          if (message.usage) {
            console.log(`[ClaudePersistent] Usage: ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`);
          }
          break;

        case 'system':
          // System messages (e.g., init)
          if (message.subtype === 'init' && message.session_id) {
            console.log(`[ClaudePersistent] Session initialized: ${message.session_id}`);
            this.sessionId = message.session_id;
            this.saveSessionId(message.session_id);
          }
          break;

        case 'stream_event':
          // Stream events are internal protocol messages, silently ignore
          // These include content_block_start, content_block_delta, etc.
          break;

        case 'result':
          // Result messages contain the final response and completion status
          console.log(`[ClaudePersistent] Result received, subtype=${message.subtype}, has result=${!!message.result}, has error=${message.is_error}`);
          console.log(`[ClaudePersistent] Result message FULL: ${JSON.stringify(message)}`);

          // NOTE: Do NOT send message.result to stream callback here!
          // The result content has already been sent via 'assistant' messages (type: 'text' blocks)
          // Sending it again would cause duplicate display in the UI

          // Only complete if we're not waiting for user input
          // The command completion should happen after all content is processed
          if (!this.isWaitingForInput) {
            // Complete the command with success or error based on is_error flag
            if (message.is_error) {
              this.completeCurrentCommand(false, message.result || 'Command failed');
            } else {
              this.completeCurrentCommand(true);
            }
          } else {
            console.log('[ClaudePersistent] Result received but waiting for input, not completing yet');
          }
          break;

        case 'assistant':
          // Assistant messages contain the actual response content
          // They can be partial (streaming) or complete
          // partial=true: streaming chunk, partial=false or undefined: complete message
          const isPartial = message.partial === true;
          console.log(`[ClaudePersistent] Assistant message, partial=${isPartial}`);

          // Check for tool_use in the nested message.content array
          const contentBlocks = message.message?.content || (Array.isArray(message.content) ? message.content : null);
          if (contentBlocks && contentBlocks.length > 0) {
            for (const block of contentBlocks) {
              if (block.type === 'tool_use') {
                console.log(`[ClaudePersistent] Tool use detected: ${block.name}, id=${block.id}`);

                // Send structured tool use event if callback is available
                if (this.currentToolUseCallback) {
                  this.currentToolUseCallback({
                    name: block.name || 'unknown',
                    id: block.id || 'unknown',
                    input: block.input || {}
                  });
                }

                // Note: We no longer send text-based tool use separators.
                // Tool use is now communicated via structured events (onToolUse callback)
                // which are converted to Feishu Card 2.0 elements by the router.

                // NOTE: Do NOT emit tool:afterExecution hook here!
                // tool_use is just a REQUEST to execute the tool, not the actual execution result.
                // The tool will be executed by Claude CLI, and we'll receive the result in a 'user' message
                // with tool_result content. We should emit the hook when we receive tool_result.
              } else if (block.type === 'text' && block.text) {
                // Stream text content to callback for real-time display
                this.currentOutputBuffer.push(block.text);
                if (this.currentStreamCallback) {
                  this.currentStreamCallback(block.text);
                }
              }
            }
          }

          // Also handle simple string content (fallback)
          if (typeof message.content === 'string' && message.content) {
            this.currentOutputBuffer.push(message.content);
            if (this.currentStreamCallback) {
              this.currentStreamCallback(message.content);
            }
            this.startInputDetectionTimer(message.content);
          }

          // Check if this is the final message (stop_reason indicates completion)
          const isComplete = message.message?.stop_reason !== null && message.message?.stop_reason !== undefined;
          if (isComplete) {
            console.log(`[ClaudePersistent] Assistant message complete, stop_reason=${message.message?.stop_reason}`);
          }
          break;

        case 'user':
          // User messages can contain tool_result blocks - need to process these
          const userTimestamp = new Date().toISOString();
          console.log(`[ClaudePersistent] User message at ${userTimestamp}, checking for tool_result...`);

          // Check if this message contains tool results
          const userContentBlocks = message.message?.content || (Array.isArray(message.content) ? message.content : null);
          if (userContentBlocks && Array.isArray(userContentBlocks)) {
            for (const block of userContentBlocks) {
              if (block.type === 'tool_result') {
                const isError = block.is_error === true;
                console.log(`[ClaudePersistent] Tool result received: tool_use_id=${block.id}, is_error=${isError}`);
                console.log(`[ClaudePersistent] Tool result full: ${JSON.stringify(message).substring(0, 500)}`);

                // Send structured tool result event if callback is available
                if (this.currentToolResultCallback) {
                  this.currentToolResultCallback({
                    tool_use_id: block.id || '',
                    content: block.content || '(no content)',
                    is_error: isError
                  });
                }

                // Note: We no longer send text-based tool result messages.
                // Tool results are now communicated via structured events (onToolResult callback)
                // which are converted to Feishu Card 2.0 elements by the router.

                // Emit hook for tool execution completion (this is the ACTUAL execution result)
                // Note: We don't have the original tool name here, but we have the tool_use_id
                claudeCodeHooks.notifyToolExecuted(
                  {
                    toolName: block.id || 'unknown', // Use tool_use_id as identifier
                    params: {}, // Original params not available in tool_result
                    timestamp: Date.now(),
                    taskId: this.currentTaskId || undefined,
                  },
                  {
                    success: !isError,
                    result: block.content || '',
                    error: isError ? (block.content || 'Tool execution failed') : undefined,
                    duration: 0, // Duration not available
                  }
                );
              }
            }
          }
          break;

        default:
          // Log unknown message types for debugging
          console.log('[ClaudePersistent] Unknown message type:', (message as { type: string }).type, 'Full message:', JSON.stringify(message).substring(0, 200));
      }
    } catch (error) {
      // Not valid JSON, treat as plain text output
      this.currentOutputBuffer.push(line);
      if (this.currentStreamCallback) {
        this.currentStreamCallback(line + '\n');
      }
    }
  }

  /**
   * Start a timer to detect if user input is requested
   * If no new output arrives within the timeout, check if the last output contains input request patterns
   */
  private startInputDetectionTimer(content: string): void {
    // Clear any existing timer
    if (this.inputDetectionTimer) {
      clearTimeout(this.inputDetectionTimer);
    }

    this.lastOutputTime = Date.now();

    // Set a timer to check for input request after a short delay
    this.inputDetectionTimer = setTimeout(() => {
      if (this.isWaitingForInput || !this.isProcessing) {
        return;
      }

      const output = this.currentOutputBuffer.join('');
      if (this.isInputRequest(output)) {
        console.log('[ClaudePersistent] Detected input request in output');
        this.handleInputRequest(output);
      }
    }, 2000); // 2 second delay to wait for more output
  }

  /**
   * Handle input request by notifying user and waiting for response
   */
  private async handleInputRequest(output: string): Promise<void> {
    // Extract the last line or prompt from output
    const lines = output.trim().split('\n');
    const lastLine = lines[lines.length - 1] || 'Please provide your response';

    // Pause processing state
    this.isWaitingForInput = true;

    // Notify through hooks
    const userInput = await this.requestInteractiveInput(lastLine);

    if (userInput !== null) {
      this.sendInput(userInput);
    } else {
      // User cancelled or timed out
      console.log('[ClaudePersistent] Input request cancelled or timed out');
      this.isWaitingForInput = false;
    }
  }

  /**
   * Check if the output indicates a request for user input
   * This detects patterns like "Press Enter to continue", "(y/n)", etc.
   */
  private isInputRequest(output: string): boolean {
    const inputPatterns = [
      /\(y\/n\?*\)/i,                    // (y/n) or (y/n?)
      /\[y\/n\]/i,                       // [y/n]
      /press enter to continue/i,       // Press Enter to continue
      /type 'yes' to continue/i,        // Type 'yes' to continue
      /waiting for your (response|input)/i, // Waiting for response/input
      /please confirm/i,                // Please confirm
      /do you want to/i,                // Do you want to...
      /would you like to/i,             // Would you like to...
      />\s*$/,                          // Prompt ending with >
      /:\s*$/,                          // Prompt ending with :
    ];

    return inputPatterns.some(pattern => pattern.test(output));
  }

  /**
   * Request user input through hooks
   * Returns a promise that resolves when user provides input via sendInput()
   */
  private async requestInteractiveInput(prompt: string): Promise<string | null> {
    console.log('[ClaudePersistent] Requesting interactive input:', prompt);
    this.isWaitingForInput = true;

    // Emit hook to notify user (fire and forget)
    claudeCodeHooks.requestUserInput({
      prompt,
      type: 'text',
      timeout: 300000, // 5 minutes timeout for input
    }).catch(() => {
      // Ignore errors from notification
    });

    // Wait for input via sendInput() or timeout
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        console.log('[ClaudePersistent] Input request timed out');
        this.isWaitingForInput = false;
        resolve(null);
      }, 300000); // 5 minutes timeout

      // Store callback to be called when sendInput is invoked
      this.inputRequestCallbacks.push((input: string) => {
        clearTimeout(timeoutId);
        resolve(input);
      });
    });
  }

  /**
   * Send user input to the Claude process
   * This is called by MessageHandler when user sends a message while waiting for input
   */
  sendInput(input: string): boolean {
    if (!this.claudeProcess || !this.isWaitingForInput) {
      console.log('[ClaudePersistent] Cannot send input - process not running or not waiting for input');
      return false;
    }

    const inputMessage: ClaudeInputMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: input,
      },
    };

    const inputLine = JSON.stringify(inputMessage);
    console.log(`[ClaudePersistent] Sending user input: ${input}`);

    this.claudeProcess.stdin?.write(inputLine + '\n');
    this.isWaitingForInput = false;

    // Notify any waiting callbacks (for requestInteractiveInput)
    for (const callback of this.inputRequestCallbacks) {
      callback(input);
    }
    this.inputRequestCallbacks = [];

    return true;
  }

  /**
   * Check if currently waiting for user input
   */
  isWaitingInput(): boolean {
    return this.isWaitingForInput;
  }

  /**
   * Complete the current command
   */
  private completeCurrentCommand(success: boolean, errorMessage?: string): void {
    // Guard against double completion
    if (!this.currentCommandResolve && !this.currentCommandReject) {
      console.log('[ClaudePersistent] Command already completed, ignoring duplicate completion');
      return;
    }

    if (this.currentTimeoutTimer) {
      clearTimeout(this.currentTimeoutTimer);
      this.currentTimeoutTimer = undefined;
    }

    const output = this.currentOutputBuffer.join('');
    console.log(`[ClaudePersistent] Completing command, success=${success}, output length=${output.length}, output preview: ${output.substring(0, 100)}...`);

    // Emit task completion hooks
    if (this.currentTaskId) {
      const endTime = Date.now();
      const duration = endTime - this.currentTaskStartTime;

      if (success) {
        claudeCodeHooks.notifyTaskCompleted(
          {
            taskId: this.currentTaskId,
            description: '', // Will be populated from queue if needed
            workingDirectory: this.currentWorkingDirectory,
            sessionId: this.sessionId || undefined,
            startTime: this.currentTaskStartTime,
          },
          {
            success: true,
            output: output.trim(),
            endTime,
            duration,
          }
        );
      } else {
        claudeCodeHooks.notifyTaskFailed(
          {
            taskId: this.currentTaskId,
            description: '',
            workingDirectory: this.currentWorkingDirectory,
            sessionId: this.sessionId || undefined,
            startTime: this.currentTaskStartTime,
          },
          new Error(errorMessage || 'Command failed')
        );
      }
    }

    if (success && this.currentCommandResolve) {
      // Get session abbreviation (last 8 characters of session ID)
      const sessionAbbr = this.sessionId ? this.sessionId.slice(-8) : undefined;
      this.currentCommandResolve({
        success: true,
        output: output.trim(),
        sessionAbbr,
      });
    } else if (this.currentCommandReject) {
      this.currentCommandReject(new Error(errorMessage || 'Command failed'));
    }

    this.resetCurrentCommand();

    // Process next command in queue
    this.isProcessing = false;
    this.processQueue();
  }

  /**
   * Reset current command state
   */
  private resetCurrentCommand(): void {
    this.currentOutputBuffer = [];
    this.currentStreamCallback = undefined;
    this.currentToolUseCallback = undefined;
    this.currentToolResultCallback = undefined;
    this.currentCommandResolve = undefined;
    this.currentCommandReject = undefined;
    if (this.currentTimeoutTimer) {
      clearTimeout(this.currentTimeoutTimer);
      this.currentTimeoutTimer = undefined;
    }
    if (this.inputDetectionTimer) {
      clearTimeout(this.inputDetectionTimer);
      this.inputDetectionTimer = undefined;
    }
    this.isWaitingForInput = false;
    // Note: currentTaskId and currentTaskStartTime are cleared separately after hooks
  }

  /**
   * Process the command queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.commandQueue.length === 0) {
      return;
    }

    // Ensure process is running
    if (!this.claudeProcess) {
      try {
        await this.startProcess();
      } catch (error) {
        // Failed to start process (e.g., working directory doesn't exist)
        // Return error result to caller without crashing the process
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[ClaudePersistent] Failed to start process:', errorMessage);

        // Get the current command from queue and return error
        const command = this.commandQueue.shift();
        if (command) {
          command.resolve({
            success: false,
            error: errorMessage,
          });
        }

        // Reset state and continue processing queue
        this.isStarting = false;
        this.processQueue();
      }
      return;
    }

    const command = this.commandQueue.shift();
    if (!command) {
      return;
    }

    this.isProcessing = true;
    this.currentStreamCallback = command.options.onStream;
    this.currentStructuredCallback = command.options.onStructuredContent;
    this.currentToolUseCallback = command.options.onToolUse;
    this.currentToolResultCallback = command.options.onToolResult;
    this.currentCommandResolve = command.resolve;
    this.currentCommandReject = command.reject;

    // Reset structured content collection
    this.structuredContentBlocks = [];

    // Generate task ID and track start time for hooks
    this.currentTaskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    this.currentTaskStartTime = Date.now();

    // Emit task started hook
    claudeCodeHooks.notifyTaskStarted({
      taskId: this.currentTaskId,
      description: command.prompt,
      workingDirectory: this.currentWorkingDirectory,
      sessionId: this.sessionId || undefined,
      startTime: this.currentTaskStartTime,
    });

    // Set timeout (only if explicitly requested via options.timeout)
    // Note: We don't set a default timeout because it can cause state inconsistency
    // - the executor times out but Claude process keeps running
    // Users can cancel long-running tasks with /abort
    if (command.options.timeout) {
      this.currentTimeoutTimer = setTimeout(() => {
        console.error('[ClaudePersistent] Command timeout');
        this.completeCurrentCommand(false, 'Execution timeout exceeded');
      }, command.options.timeout);
    }

    // Send the command
    const inputMessage: ClaudeInputMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: command.prompt,
      },
    };

    const inputLine = JSON.stringify(inputMessage);
    console.log(`[ClaudePersistent] Sending command: ${command.prompt.substring(0, 100)}...`);

    this.claudeProcess.stdin?.write(inputLine + '\n');
  }

  /**
   * Execute a command through the persistent Claude process
   */
  async execute(
    prompt: string,
    options: PersistentClaudeOptions = {}
  ): Promise<PersistentClaudeResult> {
    if (this.isDestroyed) {
      return {
        success: false,
        error: 'Executor has been destroyed',
      };
    }

    return new Promise((resolve, reject) => {
      // Add to queue
      this.commandQueue.push({
        prompt,
        options,
        resolve,
        reject,
      });

      // Try to process queue
      this.processQueue();
    });
  }

  /**
   * Abort current command execution
   * Stops the current process and rejects the pending command
   */
  async abort(): Promise<boolean> {
    if (!this.isProcessing && !this.isWaitingForInput) {
      console.log('[ClaudePersistent] No command is currently executing');
      return false;
    }

    // If waiting for input, cancel the input request
    if (this.isWaitingForInput) {
      console.log('[ClaudePersistent] Cancelling input request...');
      this.isWaitingForInput = false;
      if (this.inputDetectionTimer) {
        clearTimeout(this.inputDetectionTimer);
        this.inputDetectionTimer = undefined;
      }
    }

    console.log('[ClaudePersistent] Aborting current command...');

    // Emit task aborted hook before stopping
    if (this.currentTaskId) {
      claudeCodeHooks.notifyTaskAborted(
        {
          taskId: this.currentTaskId,
          description: '',
          workingDirectory: this.currentWorkingDirectory,
          sessionId: this.sessionId || undefined,
          startTime: this.currentTaskStartTime,
        },
        'Command aborted by user via /abort'
      );
    }

    // Mark as intentional stop before rejecting and stopping
    this.isStopping = true;

    // Reject current command if any
    if (this.currentCommandReject) {
      this.currentCommandReject(new Error('Command aborted by user'));
    }

    // Reset command state
    this.resetCurrentCommand();
    this.isProcessing = false;
    this.currentTaskId = null;
    this.currentTaskStartTime = 0;

    // Stop the process to ensure clean state
    await this.stopProcess();
    console.log('[ClaudePersistent] Process stopped after abort');

    // Clear any pending commands in queue
    if (this.commandQueue.length > 0) {
      console.log(`[ClaudePersistent] Clearing ${this.commandQueue.length} pending commands from queue`);
      for (const command of this.commandQueue) {
        command.reject(new Error('Command aborted by user'));
      }
      this.commandQueue = [];
    }

    return true;
  }

  /**
   * Reset execution context
   * Clears the session ID to start a fresh conversation on next command.
   * Does NOT stop the process - the process continues running and will
   * create a new session automatically when the next command is executed.
   */
  resetContext(): void {
    console.log('[ClaudePersistent] Resetting session context');
    this.sessionId = null;

    // Remove session file so a new session will be created on next command
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        fs.unlinkSync(this.sessionFilePath);
        console.log('[ClaudePersistent] Session file removed');
      }
    } catch (error) {
      console.error('[ClaudePersistent] Failed to remove session file:', error);
    }

    // Note: We intentionally do NOT stop the process here.
    // The process keeps running, and on the next command it will
    // start a new session automatically (since sessionId is null).
  }

  /**
   * Destroy executor and cleanup
   */
  async destroy(): Promise<void> {
    this.isDestroyed = true;

    // Clear queue and reject pending commands
    for (const command of this.commandQueue) {
      command.reject(new Error('Executor has been destroyed'));
    }
    this.commandQueue = [];

    if (this.currentCommandReject) {
      this.currentCommandReject(new Error('Executor has been destroyed'));
      this.resetCurrentCommand();
    }

    // Stop process
    await this.stopProcess();

    // Remove all listeners
    this.removeAllListeners();
  }


  /**
   * Check if process is running
   */
  isProcessRunning(): boolean {
    return this.claudeProcess !== null && !this.claudeProcess.killed;
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }
}
