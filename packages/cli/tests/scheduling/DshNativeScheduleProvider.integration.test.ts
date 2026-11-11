import { describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { DshNativeScheduleProvider } from '../../src/scheduling/DshNativeScheduleProvider';
import type { NativeScheduleEvent, NativeScheduleHandle } from '../../src/scheduling/types';
import type { DshLaunch } from '../../src/scheduling/dsh/launch';
import { ScheduleService } from '../../src/scheduling/ScheduleService';
import { ScheduleDeliveryClient } from '../../src/scheduling/ScheduleDeliveryClient';
import type { WebSocketClient } from '../../src/client/WebSocketClient';

// Explicit opt-in: requires a CLI build and exactly the reviewed native distribution.
const enabled = process.env.DSH_SCHEDULING_INTEGRATION === '1';
describe.skipIf(!enabled)('real DSH first-party scheduler and ACP multiplexer', () => {
  it.concurrent.each(['completed', 'error', 'cancel', 'guard', 'recurring'] as const)('verifies native %s without real inference or external messages', async mode => {
    const homes: string[] = [];
    const handles: NativeScheduleHandle[] = [];
    const services: ScheduleService[] = [];
    const deliveries: ScheduleDeliveryClient[] = [];
    try {
      const version = spawnSync('dsh', ['--version'], { encoding: 'utf8', timeout: 10000 });
      expect(version.status).toBe(0); expect(version.stdout.trim()).toBe('0.2.1-rc.5');
      const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-native-integration-')));
      homes.push(home);
      const fixture = path.join(home, 'synthetic-model.mjs');
      await fs.writeFile(fixture, `export const name = 'synthetic-native-model';
  export const inject = ['llm'];
  export function apply(ctx) {
    let calls = 0;
    let denied = false;
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result' && event.data.message.toolCallId === 'synthetic-guard-call') denied = event.data.message.isError === true;
    });
    ctx.on('llm/stream', async function* () {
      ${mode === 'guard' ? `if (++calls === 1) {
        yield {type:'block-start',index:0,blockType:'tool-call'};
        yield {type:'block-end',index:0,block:{type:'tool-call',id:'synthetic-guard-call',name:'schedule_create',arguments:JSON.stringify({after_seconds:120,title:'Nested synthetic job',prompt:'Must never run'})}};
        yield {type:'finish',reason:{kind:'tool-calls'}};
        return;
      }
      if (!denied || calls > 2) throw new Error('Native schedule guard failed.');` : ''}
      ${mode === 'error' ? "throw new Error('Synthetic provider failure');" : ''}
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text:'SYNTHETIC_NATIVE_RESULT'};
      yield {type:'block-end',index:0,block:{type:'text',text:'SYNTHETIC_NATIVE_RESULT'}};
      yield {type:'finish',reason:{kind:'stop'}};
    });
    ctx.provide('syntheticModelReady', {});
  }
  `, { mode: 0o600 });
      let launch!: DshLaunch;
      let settle!: () => void;
      const terminal = new Promise<void>(resolve => { settle = resolve; });
      const events: NativeScheduleEvent[] = [];
      const provider = new DshNativeScheduleProvider({ managementTimeoutMs: 15000, shutdownTimeoutMs: 2000,
        launch: async () => {
          // Exercise the exact CommonJS bridge artifact included by tsc and npm's existing dist packaging.
          const built = require('../../dist/scheduling/dsh/launch.js') as { createLaunch(): Promise<DshLaunch> };
          launch = await built.createLaunch();
          const overlay = launch.args.at(-1)!;
          await fs.appendFile(overlay, `- id: remote-cli-schedule\n  inject: [syntheticModelReady]\n- insert:\n    - id: synthetic-model\n      name: ${JSON.stringify(fixture)}\n`);
          // Do not expose real authentication/configuration to the synthetic probe.
          launch.env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
          return launch;
        },
      });
      const frames: Array<Record<string, any>> = [];
      let acknowledge!: (id: string) => void;
      const delivery = new ScheduleDeliveryClient({ isConnected: () => true,
        onClose: () => () => {}, onTaskResultAck: (callback: (id: string) => void) => { acknowledge = callback; return () => {}; },
        send: (frame: Record<string, any>) => {
          frames.push(frame);
          // In-memory Router receipt boundary; no real Feishu or external socket.
          if (frame.type === 'response') acknowledge(frame.messageId);
          return true;
        },
      } as unknown as WebSocketClient);
      deliveries.push(delivery);
      let handle!: NativeScheduleHandle;
      const owner = { openId: 'synthetic-owner', threadId: 'synthetic-thread', generation: 'synthetic-generation' };
      const service = new ScheduleService({ directory: path.join(home, 'catalog'),
        isOwnerCurrent: candidate => candidate.generation === owner.generation,
        deliver: result => delivery.deliver(result, 'Synthetic thread'),
        provider: { create: async (input, onEvent) => {
          handle = await provider.create(input, event => {
            events.push(event); onEvent(event);
            if (event.type === 'stopped' || (mode === 'recurring' && event.type === 'completed')) settle();
          });
          handles.push(handle); return handle;
        } },
      });
      services.push(service); await service.initialize();
      await service.create(owner, { id: 'synthetic-integration', backend: 'dsh', prompt: 'Synthetic text only', cwd: home,
        rule: mode === 'cancel' ? { kind: 'cron', expression: '0 0 1 1 *', timezone: 'Pacific/Honolulu' }
          : mode === 'recurring' ? { kind: 'cron', expression: '* * * * *', timezone: 'UTC' }
            : { kind: 'once', at: new Date(Math.ceil((Date.now() + 6000) / 60000) * 60000).toISOString() },
      });
      expect(await handle.list()).toBe(true);
      if (mode === 'cancel') await service.cancel(owner, 'synthetic-integration');
      else {
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([terminal, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic native occurrence timed out.')), 75000); })]); }
        finally { clearTimeout(timer); }
      }
      if (mode !== 'cancel') {
        await vi.waitFor(() => expect(frames.filter(frame => frame.type === 'response')).toHaveLength(1));
        const result = frames.find(frame => frame.type === 'response')!;
        expect(result).toMatchObject({ openId: owner.openId, threadId: owner.threadId,
          success: mode !== 'error', queueStarted: { backend: 'dsh', source: 'schedule' } });
        await service.retryDeliveries();
        expect(frames.filter(frame => frame.type === 'response')).toHaveLength(1);
      } else expect(frames).toEqual([]);
      if (mode === 'recurring') { expect(await handle.list()).toBe(true); await service.cancel(owner, 'synthetic-integration'); }
      await handle.stop();
      const completed = events.filter(event => event.type === 'completed');
      if (mode === 'cancel') expect(completed).toEqual([]);
      else {
        expect(events.filter(event => event.type === 'started')).toHaveLength(1);
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject({ success: mode !== 'error' });
        if (mode !== 'error') expect(completed[0]).toMatchObject({ output: 'SYNTHETIC_NATIVE_RESULT' });
      }
      expect(events.at(-1)).toMatchObject({ type: 'stopped', exitConfirmed: true });
      await expect(fs.stat(launch.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readdir(home)).not.toContain('sessions');
    } finally {
      // Each concurrent native probe owns independent processes, storage and receipt handlers.
      for (const service of services) await service.destroy();
      for (const delivery of deliveries) delivery.destroy();
      for (const handle of handles) await handle.stop();
      for (const home of homes) await fs.rm(home, { recursive: true, force: true });
    }
  }, 90000);
});
