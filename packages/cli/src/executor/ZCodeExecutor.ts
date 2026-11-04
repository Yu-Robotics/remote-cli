import { DirectoryGuard } from '../security/DirectoryGuard';
import { AcpExecutor, type AcpExecutorOptions } from './AcpExecutor';
import type { AcpEventCallbacks, AcpTransport } from './acp/AcpClient';
import { ZCodeClient } from './zcode/ZCodeClient';
import { resolveZCodeLaunch, type ZCodeLaunchSpec } from './zcode/ZCodeCommand';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { configuredZCodeOwnedHistory, ownedZCodeLaunch, captureZCodeOwnedHistory,
  captureZCodeSharedHistory, observeZCodeSharedPrompt,
  type ZCodeOwnedNamespace, type ZCodeOwnedTarget } from '../delegation/ZCodeOwnedHistory';
import { selectZCodeStorage, type ZCodeStorageSelection } from './zcode/ZCodeStorageSelection';
import type { NativeSessionDeletionTarget } from '../delegation/NativeSessionDeletion';

export interface ZCodeExecutorOptions {
  model?: string;
  effort?: string;
  autoApprove?: boolean;
  initialWorkingDirectory?: string;
  zcodeCommand?: string;
  threadId?: string;
  delegationWorker?: boolean;
  sessionBaseDir?: string;
  launch?: ZCodeLaunchSpec;
  clientFactory?: (callbacks: AcpEventCallbacks, cwd: string, ownedNamespace?: ZCodeOwnedNamespace) => AcpTransport;
}

interface CaptureState {
  observer?: (target: NativeSessionDeletionTarget) => Promise<void>;
  failure?: () => Promise<void>;
  active: number;
  unconfirmed: boolean;
}

/** Persistent executor that talks directly to the official ZCode app-server. */
export class ZCodeExecutor extends AcpExecutor {
  private readonly capture: CaptureState;
  private readonly ownedWorker: boolean;
  constructor(directoryGuard: DirectoryGuard, options: ZCodeExecutorOptions = {}) {
    const autoApprove = options.autoApprove ?? true;
    const capture: CaptureState = { active: 0, unconfirmed: false };
    const managed = options.delegationWorker === true && /^delegate-lane-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.threadId ?? '');
    const failed = async () => {
      capture.unconfirmed = true;
      if (capture.failure) { await capture.failure(); capture.unconfirmed = false; }
    };
    const clientFactory = (callbacks: AcpEventCallbacks, cwd: string): AcpTransport => {
      let namespace: ZCodeOwnedNamespace | undefined;
      let selected: ZCodeStorageSelection | undefined;
      let home = '', pointer = '';
      // Preserve native user/project configuration and all launch environment
      // values. ZCODE_STORAGE_DIR and the DB path also select non-history state.
      const configuredLaunch = options.launch ?? (options.clientFactory
        ? { command: options.zcodeCommand ?? 'zcode', args: [], env: { ...process.env } }
        : resolveZCodeLaunch(options.zcodeCommand));
      if (managed) {
        home = fs.realpathSync(os.homedir());
        pointer = path.join(options.sessionBaseDir ?? path.join(home, '.remote-cli', 'zcode-sessions'), options.threadId! + '.json');
        namespace = configuredZCodeOwnedHistory(configuredLaunch, home, options.threadId!, pointer);
        if (!namespace) {
          try { selected = selectZCodeStorage(configuredLaunch, cwd, home); }
          catch { /* Unsupported metadata holds cleanup, never changes the task launch. */ }
        }
      }
      const launch = options.clientFactory ? undefined : namespace
        ? ownedZCodeLaunch(configuredLaunch, namespace) : configuredLaunch;
      const client = options.clientFactory ? options.clientFactory(callbacks, cwd, namespace) : new ZCodeClient({
        cwd, command: options.zcodeCommand, autoApprove, delegationWorker: options.delegationWorker,
        launch,
      }, callbacks);
      if (!managed) return client;
      const create = client.newSession.bind(client);
      client.newSession = async (...args) => {
        capture.active++;
        try {
          const result = await create(...args);
          if (!capture.observer) { await failed(); return result; }
          let target: ZCodeOwnedTarget;
          try {
            if (!result.sessionId) throw new Error('ZCode creation ownership unavailable');
            // Observe the native create reply even if cancellation prevents ACP's
            // subsequent pointer save. This barrier also precedes every prompt.
            if (namespace) target = captureZCodeOwnedHistory(namespace, result.sessionId, args[0], options.zcodeCommand ?? 'zcode', true, launch);
            else if (selected) target = captureZCodeSharedHistory(home, options.threadId!, pointer, selected, result.sessionId,
              args[0], options.zcodeCommand ?? 'zcode', configuredLaunch);
            else throw new Error('ZCode storage selection unavailable');
          } catch { await failed(); return result; }
          try {
            // The coordinator adds this discriminant to the shared durable union.
            await capture.observer(target as unknown as NativeSessionDeletionTarget);
          } catch (error) { await failed(); throw error; }
          return result;
        } catch (error) { await failed(); throw error; }
        finally { capture.active--; }
      };
      if (!namespace) {
        const prompt = client.prompt.bind(client);
        client.prompt = async (sessionId, blocks) => {
          capture.active++;
          try {
            let tracked = false;
            try {
              if (!selected) throw new Error('ZCode storage selection unavailable');
              observeZCodeSharedPrompt(home, options.threadId!, sessionId, selected, false); tracked = true;
            } catch { await failed(); }
            try { return await prompt(sessionId, blocks); }
            finally {
              if (tracked) {
                try { observeZCodeSharedPrompt(home, options.threadId!, sessionId, selected!, true); }
                catch { /* Durable prompted state remains held unless its original DB confirms the ID. */ }
              }
            }
          } finally { capture.active--; }
        };
      }
      return client;
    };
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
      delegationWorker: options.delegationWorker,
      sessionBaseDir: options.sessionBaseDir,
      clientFactory,
      preserveSessionOnResumeError: managed,
      managedLifecycle: managed,
    };
    super(directoryGuard, baseOptions);
    this.capture = capture;
    this.ownedWorker = managed;
  }

  override observeNativeSessionCreation(observer: (target: NativeSessionDeletionTarget) => Promise<void>, onFailure?: () => Promise<void>): void {
    if (!this.ownedWorker) return;
    this.capture.observer = observer;
    this.capture.failure = onFailure;
  }

  override async waitForManagedProcessGroupExit(): Promise<void> {
    if (this.capture.active || this.capture.unconfirmed) throw new Error('ZCode native creation coverage is unconfirmed');
    await super.waitForManagedProcessGroupExit();
    if (this.capture.active || this.capture.unconfirmed) throw new Error('ZCode native creation coverage changed during shutdown');
  }

  override async deleteThreadData(threadId: string): Promise<void> {
    if (this.ownedWorker) { await this.destroy(); return; }
    await super.deleteThreadData(threadId);
  }
}
