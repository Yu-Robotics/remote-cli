import { DirectoryGuard } from '../security/DirectoryGuard';
import { AcpExecutor } from './AcpExecutor';
import type { AcpEventCallbacks, AcpTransport } from './acp/AcpClient';
import { queryKimiAccountUsage } from './kimi/KimiAccountUsage';
import { latestKimiModelCatalog, refreshKimiModelCatalog } from './kimi/KimiModelCatalog';
import type { ExecuteResult, ExecutorModelInfo } from './IExecutor';

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
  modelCatalogQuery?: (command: string, cwd: string) => Promise<ExecutorModelInfo[]>;
}

/** Kimi Code executor backed by the official persistent ACP server. */
export class KimiExecutor extends AcpExecutor {
  private readonly kimiCommand: string;
  private readonly accountUsageQuery: (command: string, cwd: string) => Promise<string | null>;
  private readonly modelCatalogQuery: (command: string, cwd: string) => Promise<ExecutorModelInfo[]>;
  private modelListing?: Promise<ExecutorModelInfo[]>;
  private discoveredCatalog?: ExecutorModelInfo[];
  private catalogEpoch = 0;

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
    this.modelCatalogQuery = options.modelCatalogQuery ?? refreshKimiModelCatalog;
  }

  async getAccountUsage(): Promise<string | null> {
    return this.accountUsageQuery(this.kimiCommand, this.getCurrentWorkingDirectory());
  }

  override listModels(): Promise<ExecutorModelInfo[]> {
    if (this.modelListing) return this.modelListing;
    let apply: ReturnType<KimiExecutor['prepareIdleModelCatalogUpdate']>;
    try { apply = this.prepareIdleModelCatalogUpdate(); }
    catch (error) { return Promise.reject(error); }
    const epoch = this.catalogEpoch;
    const operation = Promise.resolve().then(() => this.modelCatalogQuery(this.kimiCommand, this.getCurrentWorkingDirectory()))
      .then(models => {
        if (epoch !== this.catalogEpoch) throw new Error('Kimi model discovery was cancelled. Retry /model when the thread is idle.');
        const result = apply(models);
        this.discoveredCatalog = models;
        return result;
      });
    this.modelListing = operation;
    const clear = () => { if (this.modelListing === operation) this.modelListing = undefined; };
    void operation.then(clear, clear);
    return operation;
  }

  override abort(): Promise<boolean> {
    this.catalogEpoch++;
    return super.abort();
  }

  override async setModel(model: string): Promise<ExecuteResult> {
    // A settings card queries through a temporary executor, whereas Apply may
    // target a long-lived ACP thread with an older configOptions snapshot.
    const catalog = latestKimiModelCatalog(this.kimiCommand) ?? this.discoveredCatalog;
    if (catalog) {
      // The existing native process may still hold the pre-refresh records.
      return this.selectIdleRefreshedModel(model, catalog);
    }
    return super.setModel(model);
  }
}
