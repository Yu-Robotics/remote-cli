import { execFile } from 'child_process';
import type { ExecutorConfig } from '../types/config';
import { DELEGATION_BACKENDS, type DelegationBackend } from './contract';
import { resolveZCodeLaunch } from '../executor/zcode/ZCodeCommand';

export interface BackendAvailability {
  backend: DelegationBackend;
  installed: boolean;
  version?: string;
  reason?: string;
  authentication: 'unknown';
  coordinator: boolean;
  worker: boolean;
  readOnly: boolean;
}

/** Discovery never sends model requests or treats a version probe as authentication. */
export class BackendRegistry {
  private cache = new Map<string, { at: number; value: Promise<BackendAvailability> }>();

  constructor(private readonly probe = (command: string, args = ['--version'], env?: NodeJS.ProcessEnv): Promise<string> => new Promise((resolve, reject) => {
    execFile(command, args, { env, timeout: 5_000, maxBuffer: 16 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('Executable is missing or its version probe failed'));
      else resolve(stdout.trim().slice(0, 160));
    });
  })) {}

  async list(config: ExecutorConfig): Promise<BackendAvailability[]> {
    return Promise.all(DELEGATION_BACKENDS.map(backend => this.get(backend, config)));
  }

  async get(backend: DelegationBackend, config: ExecutorConfig): Promise<BackendAvailability> {
    const launch = backend === 'zcode' ? resolveZCodeLaunch(config.zcode?.command) : undefined;
    const command = launch?.command ?? config[backend]?.command ?? backend;
    const args = launch ? [...launch.args.slice(0, launch.args.indexOf('app-server')), '--version'] : undefined;
    const key = `${backend}\0${command}\0${JSON.stringify(args)}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    const versionProbe = launch ? this.probe(command, args, launch.env) : this.probe(command);
    const value = versionProbe.then(version => ({ backend, installed: true, version,
      authentication: 'unknown' as const, coordinator: true, worker: true, readOnly: backend === 'claude' || backend === 'codex' }),
    (error: Error) => ({ backend, installed: false, reason: error.message,
      authentication: 'unknown' as const, coordinator: false, worker: false, readOnly: false }));
    if (this.cache.size > 30) this.cache.clear();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  invalidate(): void { this.cache.clear(); }
}
