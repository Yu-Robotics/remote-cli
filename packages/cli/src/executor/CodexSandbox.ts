import * as fs from 'fs';
import os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DirectoryGuard } from '../security/DirectoryGuard';
import type { CodexSandboxConfig } from '../types/config';

/** Local, per-thread authorization. Backend session resets do not erase it. */
export class CodexSandbox {
  private override?: CodexSandboxConfig;
  private readonly storePath?: string;
  readonly temporaryDirectory: string;

  constructor(
    private readonly guard: DirectoryGuard,
    private readonly defaults: CodexSandboxConfig | undefined,
    threadId?: string,
  ) {
    if (defaults !== undefined) this.defaults = this.validate(defaults);
    if (threadId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(threadId)) throw new Error('Invalid thread ID for sandbox storage.');
    const id = encodeURIComponent(threadId || randomUUID());
    this.temporaryDirectory = this.normalize(path.join(os.tmpdir(), 'remote-cli', id));
    if (threadId) {
      this.storePath = path.join(os.homedir(), '.remote-cli', 'codex-sandbox', `${id}.json`);
      if (fs.existsSync(this.storePath)) {
        // Invalid authorization must fail closed, never fall back to full access.
        const stored = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
        this.override = this.validate(stored);
        if (stored.writableRoots?.some((root: string, index: number) => root !== this.override!.writableRoots![index])) {
          throw new Error('A saved sandbox grant changed its symbolic-link target. Reauthorize the directory before continuing.');
        }
      }
    }
  }

  getConfig(): CodexSandboxConfig | undefined {
    const config = this.override ?? this.defaults;
    return config ? { ...config, writableRoots: config.writableRoots ? [...config.writableRoots] : undefined } : undefined;
  }

  isRestricted(): boolean {
    const mode = this.getConfig()?.mode;
    return mode === 'workspace-write' || mode === 'read-only';
  }

  configure(config: CodexSandboxConfig | undefined): void {
    const validated = config === undefined ? undefined : this.validate(config);
    if (this.storePath) {
      if (validated) {
        fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
        const temporary = `${this.storePath}.${randomUUID()}.tmp`;
        try {
          fs.writeFileSync(temporary, JSON.stringify(validated, null, 2), { mode: 0o600 });
          fs.renameSync(temporary, this.storePath);
        } finally {
          if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
      } else if (fs.existsSync(this.storePath)) fs.unlinkSync(this.storePath);
    }
    this.override = validated;
  }

  deleteData(): void {
    this.configure(undefined);
  }

  /** Resolve symlinks, including the existing parent of a new directory. */
  normalize(directory: string, cwd?: string): string {
    if (typeof directory !== 'string' || /[\x00-\x1f]/.test(directory)) {
      throw new Error('Sandbox directories must be non-empty paths without control characters.');
    }
    const normalized = this.guard.normalizePath(directory, cwd);
    let ancestor = normalized;
    const suffix: string[] = [];
    while (!fs.existsSync(ancestor)) {
      if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error(`Sandbox directory is a broken symbolic link: ${ancestor}`);
      }
      suffix.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error(`Cannot resolve sandbox directory: ${directory}`);
      ancestor = parent;
    }
    if (!fs.statSync(ancestor).isDirectory()) throw new Error(`Sandbox path is not a directory: ${ancestor}`);
    return path.join(fs.realpathSync(ancestor), ...suffix);
  }

  writableRoots(cwd: string, create = false): string[] {
    const config = this.getConfig();
    if (config?.mode !== 'workspace-write') return [];
    const home = os.homedir();
    const directories = [cwd, this.temporaryDirectory];
    if (config.developmentDirectories !== false) {
      directories.push(path.join(home, 'workspace', '_incoming'), path.join(home, '.npm'));
      const cache = process.platform === 'darwin' ? path.join(home, 'Library', 'Caches') : path.join(home, '.cache');
      directories.push(path.join(cache, 'pip'), path.join(cache, 'uv'), path.join(cache, 'go-build'));
    }
    for (const root of config.writableRoots ?? []) {
      if (this.normalize(root) !== root) throw new Error(`Authorized sandbox directory changed its symbolic-link target: ${root}`);
      directories.push(root);
    }
    const roots = [...new Set(directories.map(directory => this.normalize(directory, cwd)))];
    if (create) for (const root of roots) fs.mkdirSync(root, { recursive: true });
    return roots;
  }

  turnOptions(cwd: string): Record<string, unknown> {
    const config = this.getConfig();
    if (!config) return {};
    if (config.mode === 'danger-full-access') return { sandboxPolicy: { type: 'dangerFullAccess' } };
    return {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: config.mode === 'read-only'
        ? { type: 'readOnly', networkAccess: config.networkAccess ?? true }
        : { type: 'workspaceWrite', writableRoots: this.writableRoots(cwd, true),
          networkAccess: config.networkAccess ?? true, excludeSlashTmp: true, excludeTmpdirEnvVar: true },
    };
  }

  threadOptions(cwd: string): Record<string, unknown> {
    const config = this.getConfig();
    if (!config) return {};
    if (!this.isRestricted()) return { sandbox: config.mode };
    return {
      sandbox: config.mode,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      config: {
        'sandbox_workspace_write.writable_roots': this.writableRoots(cwd, true),
        'sandbox_workspace_write.network_access': config.networkAccess ?? true,
        'sandbox_workspace_write.exclude_slash_tmp': true,
        'sandbox_workspace_write.exclude_tmpdir_env_var': true,
        'shell_environment_policy.set.TMPDIR': this.temporaryDirectory,
        'shell_environment_policy.set.TMP': this.temporaryDirectory,
        'shell_environment_policy.set.TEMP': this.temporaryDirectory,
      },
    };
  }

  describe(cwd: string): string {
    const config = this.getConfig();
    return [
      `Codex sandbox: ${config?.mode ?? 'not configured (existing Codex settings apply)'}`,
      ...(this.isRestricted() ? [
        'Reads: existing OS permissions; cross-project reads are allowed.',
        `Network: ${config?.networkAccess === false ? 'restricted' : 'enabled'}`,
        `Writable directories:\n${this.writableRoots(cwd).map(root => `- ${root}`).join('\n') || '- None'}`,
        'Requests outside this policy require approval. Explicit approvals can widen access.',
      ] : []),
      'Usage: /sandbox on|off|read-only|default; /sandbox network on|off; /sandbox allow <directory>; /sandbox remove <directory>',
      'Directory authorizations belong to this thread and survive /clear, backend switches, and restarts.',
    ].join('\n');
  }

  private validate(value: unknown): CodexSandboxConfig {
    const config = value as CodexSandboxConfig;
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || !['workspace-write', 'read-only', 'danger-full-access'].includes(config.mode)
      || (config.networkAccess !== undefined && typeof config.networkAccess !== 'boolean')
      || (config.developmentDirectories !== undefined && typeof config.developmentDirectories !== 'boolean')
      || (config.writableRoots !== undefined && (!Array.isArray(config.writableRoots)
        || config.writableRoots.some(root => typeof root !== 'string' || !root.trim())))) {
      throw new Error('Invalid Codex sandbox configuration. Expected mode, optional networkAccess/developmentDirectories booleans, and writableRoots paths.');
    }
    return { ...config, writableRoots: config.writableRoots?.map(root => this.normalize(root)) };
  }
}
