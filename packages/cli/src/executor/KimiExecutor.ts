import { DirectoryGuard } from '../security/DirectoryGuard';
import { AcpExecutor } from './AcpExecutor';
import type { AcpEventCallbacks, AcpTransport } from './acp/AcpClient';
import { queryKimiAccountUsage } from './kimi/KimiAccountUsage';

export interface KimiExecutorOptions {
  model?: string;
  effort?: string;
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  kimiCommand?: string;
  threadId?: string;
  delegationWorker?: boolean;
  sessionBaseDir?: string;
  clientFactory?: (callbacks: AcpEventCallbacks, cwd: string) => AcpTransport;
  accountUsageQuery?: (command: string, cwd: string) => Promise<string | null>;
}

/** Kimi Code executor backed by the official persistent ACP server. */
export class KimiExecutor extends AcpExecutor {
  private readonly kimiCommand: string;
  private readonly accountUsageQuery: (command: string, cwd: string) => Promise<string | null>;

  constructor(directoryGuard: DirectoryGuard, options: KimiExecutorOptions = {}) {
    const kimiCommand = options.kimiCommand ?? 'kimi';
    super(directoryGuard, {
      model: options.model,
      effort: options.effort,
      autoApprove: options.autoApprove,
      initialWorkingDirectory: options.initialWorkingDirectory,
      threadId: options.threadId,
      delegationWorker: options.delegationWorker,
      sessionBaseDir: options.sessionBaseDir,
      clientFactory: options.clientFactory,
      acpCommand: kimiCommand,
      acpArgs: ['acp'],
      backendLabel: 'Kimi Code',
      sessionNamespace: 'kimi-sessions',
      effortConfigId: 'thinking',
      effortAutoValue: 'on',
      installCommand: 'npm install --global @moonshot-ai/kimi-code',
      authCommand: 'kimi login',
    });
    this.kimiCommand = kimiCommand;
    this.accountUsageQuery = options.accountUsageQuery ?? queryKimiAccountUsage;
  }

  async getAccountUsage(): Promise<string | null> {
    return this.accountUsageQuery(this.kimiCommand, this.getCurrentWorkingDirectory());
  }
}
