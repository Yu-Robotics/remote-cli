import * as fs from 'fs';
import os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DirectoryGuard } from '../../security/DirectoryGuard';
import type { ClaudeSandboxConfig } from '../../types/config';

/**
 * Local, per-thread Claude sandbox authorization. Backend session resets do
 * not erase it. Mirrors CodexSandbox semantics; maps to Claude Code's native
 * sandbox settings at process spawn.
 */
export class ClaudeSandbox {
  private override?: ClaudeSandboxConfig;
  private readonly storePath?: string;

  constructor(
    private readonly guard: DirectoryGuard,
    private readonly defaults: ClaudeSandboxConfig | undefined,
    threadId?: string,
  ) {
    if (defaults !== undefined) this.defaults = this.validate(defaults);
    if (threadId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(threadId)) throw new Error('Invalid thread ID for sandbox storage.');
    if (threadId) {
      const id = encodeURIComponent(threadId);
      this.storePath = path.join(os.homedir(), '.remote-cli', 'claude-sandbox', `${id}.json`);
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

  getConfig(): ClaudeSandboxConfig | undefined {
    const config = this.override ?? this.defaults;
    return config ? { ...config, writableRoots: config.writableRoots ? [...config.writableRoots] : undefined } : undefined;
  }

  isRestricted(): boolean {
    const mode = this.getConfig()?.mode;
    return mode === 'workspace-write' || mode === 'read-only';
  }

  configure(config: ClaudeSandboxConfig | undefined): void {
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

  /** Extra writable roots beyond the working directory (validated, normalized). */
  extraWritableRoots(): string[] {
    const config = this.getConfig();
    if (config?.mode !== 'workspace-write') return [];
    for (const root of config.writableRoots ?? []) {
      if (this.normalize(root) !== root) throw new Error(`Authorized sandbox directory changed its symbolic-link target: ${root}`);
    }
    return [...new Set((config.writableRoots ?? []).map(root => this.normalize(root)))];
  }

  /**
   * Build the Claude Code settings object injected via --settings at spawn.
   * Sandboxed commands run without prompts; widening requests surface through
   * the permission-prompt tool instead.
   */
  spawnSettings(cwd: string): Record<string, unknown> | undefined {
    const config = this.getConfig();
    if (!config || !this.isRestricted()) return undefined;
    const filesystem: Record<string, unknown> = {};
    if (config.mode === 'workspace-write') {
      const extra = this.extraWritableRoots();
      if (extra.length > 0) filesystem.allowWrite = extra;
    } else {
      // read-only: revoke the default working-directory write grant.
      filesystem.denyWrite = [this.normalize(cwd)];
    }
    const network: Record<string, unknown> = {};
    if (config.networkAccess === false) {
      // Hard-deny egress instead of prompting for each new domain.
      network.allowedDomains = [];
      network.strictAllowlist = true;
    }
    return {
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        // Widening requests must go through the permission-prompt channel.
        allowUnsandboxedCommands: true,
        filesystem,
        network,
      },
    };
  }

  describe(cwd: string): string {
    const config = this.getConfig();
    return [
      `Claude sandbox: ${config?.mode ?? 'not configured (existing Claude Code settings apply)'}`,
      ...(this.isRestricted() ? [
        'Scope: OS-enforced for Bash commands; file edits and other tools ask via approval cards.',
        `Network: ${config?.networkAccess === false ? 'denied' : 'new domains require approval'}`,
        `Writable directories:\n- ${this.normalize(cwd)}\n${this.extraWritableRoots().map(root => `- ${root}`).join('\n')}`,
        'Requests outside this policy require approval.',
      ] : []),
      'Usage: /sandbox on|off|read-only|default; /sandbox network on|off; /sandbox allow <directory>; /sandbox remove <directory>',
      'Directory authorizations belong to this thread and survive /clear, backend switches, and restarts.',
    ].join('\n');
  }

  private validate(value: unknown): ClaudeSandboxConfig {
    const config = value as ClaudeSandboxConfig;
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || !['workspace-write', 'read-only', 'danger-full-access'].includes(config.mode)
      || (config.networkAccess !== undefined && typeof config.networkAccess !== 'boolean')
      || (config.writableRoots !== undefined && (!Array.isArray(config.writableRoots)
        || config.writableRoots.some(root => typeof root !== 'string' || !root.trim())))) {
      throw new Error('Invalid Claude sandbox configuration. Expected mode, optional networkAccess boolean, and writableRoots paths.');
    }
    return { ...config, writableRoots: config.writableRoots?.map(root => this.normalize(root)) };
  }
}
