import { DirectoryGuard } from '../security/DirectoryGuard';
import { AcpExecutor } from './AcpExecutor';
import type { AcpEventCallbacks, AcpTransport } from './acp/AcpClient';

export interface KimiExecutorOptions {
  model?: string;
  effort?: string;
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  kimiCommand?: string;
  threadId?: string;
  sessionBaseDir?: string;
  clientFactory?: (callbacks: AcpEventCallbacks, cwd: string) => AcpTransport;
}

/** Kimi Code executor backed by the official persistent ACP server. */
export class KimiExecutor extends AcpExecutor {
  constructor(directoryGuard: DirectoryGuard, options: KimiExecutorOptions = {}) {
    super(directoryGuard, {
      model: options.model,
      effort: options.effort,
      autoApprove: options.autoApprove,
      initialWorkingDirectory: options.initialWorkingDirectory,
      threadId: options.threadId,
      sessionBaseDir: options.sessionBaseDir,
      clientFactory: options.clientFactory,
      acpCommand: options.kimiCommand ?? 'kimi',
      acpArgs: ['acp'],
      backendLabel: 'Kimi Code',
      sessionNamespace: 'kimi-sessions',
      effortConfigId: 'thinking',
      effortAutoValue: 'on',
      installCommand: 'npm install --global @moonshot-ai/kimi-code',
      authCommand: 'kimi login',
    });
  }
}
