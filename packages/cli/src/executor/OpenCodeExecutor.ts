import { DirectoryGuard } from '../security/DirectoryGuard';
import { AcpExecutor } from './AcpExecutor';
import type { AcpEventCallbacks, AcpTransport } from './acp/AcpClient';

/** Disable the native question tool without changing user or project configuration. */
function noQuestionEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  // A plain object loses Windows process.env's case-insensitive key lookup.
  if (process.platform === 'win32') {
    for (const name of ['OPENCODE_PERMISSION', 'OPENCODE_ENABLE_QUESTION_TOOL']) {
      const aliases = Object.keys(environment).filter(key => key.toUpperCase() === name);
      const existing = environment[name] ?? environment[aliases[0]];
      for (const alias of aliases) delete environment[alias];
      if (existing !== undefined) environment[name] = existing;
    }
  }
  const isAction = (value: unknown): value is string => typeof value === 'string' && ['allow', 'ask', 'deny'].includes(value);
  let permissions: Record<string, unknown> = {};
  if (environment.OPENCODE_PERMISSION !== undefined) {
    try {
      const parsed: unknown = JSON.parse(environment.OPENCODE_PERMISSION);
      if (isAction(parsed)) {
        permissions = { '*': parsed };
      } else if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !Object.entries(parsed).every(([key, value]) => isAction(value)
          || (value !== null && typeof value === 'object' && !Array.isArray(value)
            && !['question', 'todowrite', 'webfetch', 'websearch', 'doom_loop'].includes(key)
            && Object.values(value).every(isAction)))) {
        throw new Error('Invalid permission rules');
      } else {
        permissions = parsed as Record<string, unknown>;
      }
    } catch {
      // Never include environment contents in diagnostics.
      throw new Error('OpenCode OPENCODE_PERMISSION must contain a valid JSON permission object before automatic approval can disable questions.');
    }
  }
  // OpenCode resolves matching rules in insertion order, with the last match winning.
  delete permissions.question;
  environment.OPENCODE_PERMISSION = JSON.stringify({ ...permissions, question: 'deny' });
  // Agent and restored-session permission rules can override a global deny.
  // Removing the built-in tool from the ACP registry also covers those overrides.
  environment.OPENCODE_ENABLE_QUESTION_TOOL = 'false';
  return environment;
}

export interface OpenCodeExecutorOptions {
  model?: string;
  effort?: string;
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  openCodeCommand?: string;
  threadId?: string;
  delegationWorker?: boolean;
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
      delegationWorker: options.delegationWorker,
      sessionBaseDir: options.sessionBaseDir,
      clientFactory: options.clientFactory,
      acpCommand: options.openCodeCommand ?? 'opencode',
      acpArgs: ['acp'],
      spawnEnvironment: (options.autoApprove ?? true) ? noQuestionEnvironment : undefined,
      backendLabel: 'OpenCode',
      sessionNamespace: 'opencode-sessions',
      effortConfigId: 'effort',
      effortAutoValue: 'default',
      installCommand: 'npm install --global @opencode/cli',
      authCommand: 'opencode auth login',
    });
  }
}
