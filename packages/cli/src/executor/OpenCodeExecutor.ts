import { DirectoryGuard } from '../security/DirectoryGuard';
import { AcpExecutor } from './AcpExecutor';
import type { AcpEventCallbacks, AcpTransport } from './acp/AcpClient';

export interface OpenCodeExecutorOptions {
  model?: string;
  effort?: string;
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  openCodeCommand?: string;
  threadId?: string;
  /** Override session pointer storage for isolated tests. */
  sessionBaseDir?: string;
  clientFactory?: (callbacks: AcpEventCallbacks, cwd: string) => AcpTransport;
}

/** OpenCode executor backed by the official persistent ACP server. */
export class OpenCodeExecutor extends AcpExecutor {
  constructor(directoryGuard: DirectoryGuard, options: OpenCodeExecutorOptions = {}) {
    super(directoryGuard, {
      model: options.model,
      effort: options.effort,
      autoApprove: options.autoApprove,
      initialWorkingDirectory: options.initialWorkingDirectory,
      threadId: options.threadId,
      sessionBaseDir: options.sessionBaseDir,
      clientFactory: options.clientFactory,
      acpCommand: options.openCodeCommand ?? 'opencode',
      acpArgs: ['acp'],
      backendLabel: 'OpenCode',
      sessionNamespace: 'opencode-sessions',
      effortConfigId: 'effort',
      effortAutoValue: 'default',
      installCommand: 'npm install --global @opencode/cli',
      authCommand: 'opencode auth login',
    });
  }
}
