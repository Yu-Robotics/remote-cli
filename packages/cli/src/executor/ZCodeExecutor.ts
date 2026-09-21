import { DirectoryGuard } from '../security/DirectoryGuard';
import { AcpExecutor, type AcpExecutorOptions } from './AcpExecutor';
import type { AcpEventCallbacks, AcpTransport } from './acp/AcpClient';
import { ZCodeClient } from './zcode/ZCodeClient';
import type { ZCodeLaunchSpec } from './zcode/ZCodeCommand';

export interface ZCodeExecutorOptions {
  model?: string;
  effort?: string;
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  zcodeCommand?: string;
  threadId?: string;
  sessionBaseDir?: string;
  launch?: ZCodeLaunchSpec;
  clientFactory?: (callbacks: AcpEventCallbacks, cwd: string) => AcpTransport;
}

/** Persistent executor that talks directly to the official ZCode app-server. */
export class ZCodeExecutor extends AcpExecutor {
  constructor(directoryGuard: DirectoryGuard, options: ZCodeExecutorOptions = {}) {
    const autoApprove = options.autoApprove ?? true;
    const clientFactory = options.clientFactory ?? ((callbacks: AcpEventCallbacks, cwd: string) => new ZCodeClient({
      cwd,
      command: options.zcodeCommand,
      autoApprove,
      launch: options.launch,
    }, callbacks));
    const baseOptions: AcpExecutorOptions = {
      model: options.model,
      effort: options.effort,
      autoApprove,
      initialWorkingDirectory: options.initialWorkingDirectory,
      acpCommand: options.zcodeCommand ?? 'zcode',
      acpArgs: [],
      backendLabel: 'ZCode',
      sessionNamespace: 'zcode-sessions',
      effortConfigId: 'thought',
      effortAutoValue: 'max',
      installCommand: 'download ZCode from https://zcode.z.ai/en/docs/install',
      authCommand: 'zcode login',
      threadId: options.threadId,
      sessionBaseDir: options.sessionBaseDir,
      clientFactory,
    };
    super(directoryGuard, baseOptions);
  }
}
