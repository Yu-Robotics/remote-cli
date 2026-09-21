import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { AcpEventCallbacks } from '../../src/executor/acp/AcpClient';
import { ZCodeClient } from '../../src/executor/zcode/ZCodeClient';

const fixture = String.raw`
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
let sendParams = null;
let permissionResponses = 0;
let goalProbes = 0;
let subscribeAttempts = 0;
const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const sessionResult = { session: { sessionId: 'sess-1' }, settings: {
  model: { current: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3' }, available: [
    { ref: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3' }, reasoning: { defaultLevel: 'max', levels: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] } },
    { ref: { providerId: 'builtin:zai-coding-plan', modelId: 'GLM-5.3-Flash' }, reasoning: { defaultLevel: 'high', levels: [{ value: 'low' }, { value: 'high' }] } }
  ] }, thoughtLevel: { current: 'max' }
} };
const finish = () => {
  write({ method: 'session/event', params: { sessionId: 'sess-1', seq: 2, type: 'turn.started', payload: { turnId: 'turn-1' } } });
  write({ method: 'session/event', params: { sessionId: 'sess-1', seq: 3, type: 'model.streaming', payload: { kind: 'text_delta', delta: 'images=' + (sendParams.attachments || []).length, turnId: 'turn-1' } } });
  write({ method: 'session/event', params: { sessionId: 'sess-1', seq: 4, type: 'model.streaming', payload: { kind: 'tool_call', toolCallId: 'call-1', toolName: 'Bash', input: { command: 'pwd' } } } });
  write({ method: 'session/event', params: { sessionId: 'sess-1', seq: 5, type: 'tool.updated', payload: { kind: 'scheduled', toolCallId: 'call-1', toolName: 'Bash' } } });
  write({ method: 'session/event', params: { sessionId: 'sess-1', seq: 6, type: 'tool.updated', payload: { kind: 'result', toolCallId: 'call-1', result: '/workspace' } } });
  write({ method: 'session/event', params: { sessionId: 'sess-1', seq: 7, type: 'turn.completed', payload: { turnId: 'turn-1', resultType: 'success' } } });
};
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'session/create') {
    write({ id: 900, method: 'session/requestRuntimePreferences', params: {} });
    write({ id: message.id, result: sessionResult });
  } else if (message.method === 'session/resume') {
    write({ id: message.id, result: sessionResult });
  } else if (message.method === 'session/subscribe') {
    subscribeAttempts += 1;
    if (subscribeAttempts === 1) write({ id: message.id, error: { code: -32004, message: 'Session is not active' } });
    else write({ id: message.id, result: { eventSeq: 1 } });
  } else if (message.method === 'session/send') {
    sendParams = message.params;
    write({ id: message.id, result: { accepted: true } });
    write({ id: 901, method: 'interaction/requestPermission', params: { toolName: 'Bash', input: { command: 'pwd' }, options: [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' }
    ], requestId: 'permission-1' } });
    write({ id: 902, method: 'interaction/requestPermission', params: { toolName: 'Bash', input: { command: 'pwd' }, options: [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' }
    ], requestId: 'permission-1' } });
  } else if ((message.id === 901 || message.id === 902) && message.result) {
    permissionResponses += 1;
    if (permissionResponses === 2) finish();
  } else if (message.method === 'session/goal') {
    goalProbes += 1;
    if (goalProbes === 1) write({ id: message.id, error: { code: 1308, message: 'prompt is running' } });
    else write({ id: message.id, result: {} });
  } else if (message.method === 'session/setModel' || message.method === 'session/setThoughtLevel' || message.method === 'session/compact') {
    write({ id: message.id, result: {} });
  }
});
`;

describe('ZCodeClient', () => {
  let temporaryDirectory: string;
  let fixturePath: string;
  let callbacks: AcpEventCallbacks;
  let client: ZCodeClient;

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-client-test-'));
    fixturePath = path.join(temporaryDirectory, 'server.cjs');
    await fs.writeFile(fixturePath, fixture);
    callbacks = {
      onTextChunk: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onPermissionRequest: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 0;
      }),
    };
    client = new ZCodeClient({
      cwd: temporaryDirectory,
      launch: { command: process.execPath, args: [fixturePath], env: process.env },
      requestTimeoutMs: 2_000,
      compactPollIntervalMs: 5,
    }, callbacks);
  });

  afterEach(async () => {
    client.destroy();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('drives the official app-server protocol directly', async () => {
    const session = await client.newSession(temporaryDirectory);
    expect(session.sessionId).toBe('sess-1');
    expect(session.configOptions?.find((option) => option.id === 'model')?.options?.map((entry) => entry.value))
      .toEqual(['GLM-5.3', 'GLM-5.3-Flash']);

    await expect(client.prompt('sess-1', [
      { type: 'text', text: 'inspect' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ])).resolves.toEqual({ stopReason: 'end_turn' });

    expect(callbacks.onPermissionRequest).toHaveBeenCalledWith('Bash: pwd', expect.arrayContaining([
      expect.objectContaining({ optionId: 'allow_once', kind: 'allow_once' }),
    ]));
    expect(callbacks.onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(callbacks.onTextChunk).toHaveBeenCalledWith({ type: 'text', text: 'images=1' });
    expect(callbacks.onToolCall).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 'call-1', rawInput: { command: 'pwd' }, kind: 'execute',
    }));
    expect(callbacks.onToolResult).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 'call-1', status: 'completed', rawOutput: '/workspace',
    }));

    await expect(client.setConfigOption('sess-1', 'model', 'GLM-5.3-Flash')).resolves.toMatchObject({ sessionId: 'sess-1' });
    await expect(client.setConfigOption('sess-1', 'thought', 'high')).resolves.toMatchObject({ sessionId: 'sess-1' });
    await expect(client.compactSession('sess-1')).resolves.toEqual({ stopReason: 'end_turn' });
    await expect(client.deleteSession('sess-1')).resolves.toBeUndefined();
  });
});
