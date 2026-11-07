import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash, generateKeyPairSync, sign } from 'crypto';
import { once } from 'events';
import { WebSocket } from 'ws';
import { RouterServer } from '../src/server';
import { JsonStore } from '../src/storage/JsonStore';

// Only the remote Feishu service is replaced: HTTP, WS, enrollment and storage are real.
vi.mock('../src/feishu/FeishuLongConnHandler', () => ({ FeishuLongConnHandler: vi.fn(() => ({
  setConnectionHub() {}, setOnStartStreaming() {}, setOnCaptureSelection() {}, setOnValidateSelection() {}, setOnResolveThread() {}, setOnResolveActiveThread() {}, bindDiagnosticTask() {}, sendStreamingStart: vi.fn(async () => 'recovery-parent'),
  patchInlineOutputCard: vi.fn(async () => {}), uploadOutputFile: vi.fn(async () => 'synthetic-file-key'), sendOutputFile: vi.fn(async () => 'synthetic-file-message'), createOutputCard: vi.fn(async () => 'unexpected-standalone'), finalizeStreamingMessage: vi.fn(async () => true),
  start: async () => {}, stop: async () => {}, sendMessage: vi.fn(),
})) }));

describe('authenticated file registration on real WebSockets', () => {
  let root: string; let server: RouterServer; let origin: string; let sockets: WebSocket[];
  const keys = () => generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const proof = (key: string, nonce: string, device = 'device') => sign(null, Buffer.from(`remote-cli-device-v1\n${device}\n${nonce}`), key).toString('base64');
  async function startServer(files?: Record<string, unknown>) {
    const config: any = { getConfigPath: () => path.join(root, 'config.json'), get: (section: string, key?: string) => {
      if (section === 'files') return files;
      if (section === 'server') return key === 'port' ? 0 : key === 'host' ? '127.0.0.1' : 'test';
      if (section === 'websocket') return 30_000;
      return 'fixture';
    } };
    const store = new JsonStore(path.join(root, 'bindings.json'), 1); await store.initialize();
    server = new RouterServer(config, store);
    await (server as any).bindingManager.bindUser('owner', 'device', 'Test device');
    await server.start();
    const http = (server as any).httpServer;
    if (!http.listening) await once(http, 'listening');
    origin = `http://127.0.0.1:${http.address().port}`;
  }
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-file-auth-'))); sockets = [];
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    await startServer();
  });
  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await server?.stop(); vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function connect() {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws'); sockets.push(ws);
    await once(ws, 'open');
    const messages: any[] = []; ws.on('message', data => messages.push(JSON.parse(data.toString())));
    const send = (signature?: string, id = 'device', hints = false, output = true, recovery = false) => ws.send(JSON.stringify({ type: 'binding_request', data: { deviceId: id, capabilities: { fileTransferV1: true, outputFilesV1: output, ...(recovery ? { taskRecovery: true } : {}), ...(hints ? { outputAttachmentHintsV1: true } : {}) }, ...(signature ? { deviceSignature: signature } : {}) } }));
    const next = async (type: string) => { await vi.waitFor(() => expect(messages.some(m => m.type === type)).toBe(true)); return messages.find(m => m.type === type); };
    return { ws, messages, send, next };
  }
  it.each(['disabled', 'approval', 'upgrade'] as const)('negotiates display-only hints with authoritative %s status without authorizing retrieval', async status => {
    await server.stop(); await startServer({ enabled: status !== 'disabled' });
    const pair = keys();
    if (status === 'upgrade') await (server as any).feishuLongConnHandler.onApproveDeviceKey('owner', 'device', pair.publicKey);
    const client = await connect(); client.send(undefined, 'device', true, false);
    if (status === 'upgrade') client.send(proof(pair.privateKey, (await client.next('device_challenge')).data.nonce), 'device', true, false);
    const confirmation = await client.next('binding_confirm');
    expect(confirmation.data.capabilities.outputAttachmentHintsV1).toBe(true);
    expect(confirmation.data.capabilities.outputFilesV1).not.toBe(true);
    expect((server as any).attachmentHintStatus.get('device')).toBe(status);
    const epoch = (server as any).selections.capture('owner', 'device').epoch;
    (server as any).streamingMessages.set('hint-request', { feishuMessageId: 'actual-parent', openId: 'owner', deviceId: 'device', threadId: 'thread', selectionFence: { epoch }, elements: [], currentTextContent: '', delegationProgress: new Map(), toolCalls: new Map() });
    client.ws.send(JSON.stringify({ type: 'response', messageId: 'hint-request', openId: 'owner', success: true, threadId: 'thread', attachmentHints: { generation: 2, names: ['report.csv'] } }));
    const inline = (server as any).inlineFileCards;
    await vi.waitFor(() => expect(inline.parents.get('hint-request')?.names).toEqual(['report.csv']), { timeout: 5000 });
    inline.remember('actual-parent', 'actual-parent', JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'Assistant reply' }] } }));
    await inline.bind('actual-parent', 'actual-parent');
    const content = (server as any).feishuLongConnHandler.patchInlineOutputCard.mock.calls.at(-1)[1];
    expect(content).toContain('"disabled":true'); expect(content).not.toContain('"action":"output_file"');
    const initialize = vi.spyOn((server as any).outputTransfers, 'initialize');
    if (status === 'disabled') {
      expect(await (server as any).feishuLongConnHandler.onOutputFileAction('owner', 'actual-parent', { id: 'a'.repeat(64), op: 'get' })).toContain('disabled');
      expect(initialize).not.toHaveBeenCalled();
    }
  });

  it('retrieves an approved snapshot through real WS/HTTP with file controls on the exact original parent', async () => {
    const pair = keys(); await (server as any).feishuLongConnHandler.onApproveDeviceKey('owner', 'device', pair.publicKey);
    const client = await connect(); client.send(undefined, 'device', true);
    client.send(proof(pair.privateKey, (await client.next('device_challenge')).data.nonce), 'device', true);
    const confirmation = await client.next('binding_confirm'); expect(confirmation.data.capabilities.outputFilesV1).toBe(true);
    const fence = (server as any).selections.capture('owner', 'device');
    (server as any).streamingMessages.set('inline-request', { feishuMessageId: 'actual-parent', openId: 'owner', deviceId: 'device', threadId: 'thread', selectionFence: fence, elements: [], currentTextContent: '', delegationProgress: new Map(), toolCalls: new Map() });
    const bytes = Buffer.from('column,value\n1,2\n');
    for (let i = 1; i <= 16; i++) client.ws.send(JSON.stringify({ type: 'output_offer', reference: { id: i.toString(16).padStart(64, '0'), sha256: createHash('sha256').update(bytes).digest('hex'), messageId: 'inline-request', threadId: 'thread', taskId: 'inline-request', generation: 2, name: `report-${i}.csv`, size: bytes.length, source: 'workspace', expiresAt: Date.now() + 60_000 } }));
    await vi.waitFor(() => expect(client.messages.filter(m => m.type === 'output_registered')).toHaveLength(16), { timeout: 5000 });
    const inline = (server as any).inlineFileCards, handler = (server as any).feishuLongConnHandler;
    inline.remember('actual-parent', 'actual-parent', JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'Original complete reply' }] } }));
    await inline.bind('actual-parent', 'actual-parent');
    const card = JSON.parse(handler.patchInlineOutputCard.mock.calls.at(-1)[1]);
    expect(card.body.elements[0].content).toBe('Original complete reply');
    const panel = card.body.elements.find((e: any) => e.element_id === 'output_files_inline');
    const next = panel.elements.find((e: any) => e.text?.content === 'Next').behaviors[0].value;
    expect(await handler.onInlineFilePage('owner', 'actual-parent', next)).toContain('updated');
    const id = '1'.padStart(64, '0');
    expect(await handler.onOutputFileAction('owner', 'inline-request', { id, op: 'get' })).toContain('unavailable');
    expect(handler.sendOutputFile).not.toHaveBeenCalled();
    expect(await handler.onOutputFileAction('owner', 'actual-parent', { id, op: 'get' })).toContain('accepted');
    await vi.waitFor(() => expect(client.messages.some(m => m.type === 'output_grant')).toBe(true), { timeout: 5000 });
    const grant = client.messages.find(m => m.type === 'output_grant');
    const response = await fetch(origin + '/api/output-files/' + grant.transferId, { method: 'POST', headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/octet-stream' }, body: bytes });
    expect(response.status).toBe(204);
    await vi.waitFor(() => expect(handler.sendOutputFile).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(handler.createOutputCard).not.toHaveBeenCalled();
    expect(handler.patchInlineOutputCard.mock.calls.every(([id]: any) => id === 'actual-parent')).toBe(true);
    expect(handler.uploadOutputFile).toHaveBeenCalledWith(expect.any(String), 'report-1.csv');
    const count = (server as any).outputTransfers.state.references.length;
    client.ws.send(JSON.stringify({ type: 'output_offer', reference: { id: 'f'.repeat(64), sha256: 'b'.repeat(64), messageId: 'inline-request', threadId: 'thread', taskId: 'inline-request', generation: 3, name: 'stale.csv', size: bytes.length, source: 'workspace', expiresAt: Date.now() + 60_000 } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((server as any).outputTransfers.state.references).toHaveLength(count);
  });

  it.each(['other-owner', 'sibling-device', 'epoch', 'thread', 'generation', 'same-source-pending', 'same-source-orphan'])('checks durable ownership and pending publication before recovering a %s card', async mismatch => {
    const pair = keys(); await (server as any).feishuLongConnHandler.onApproveDeviceKey('owner', 'device', pair.publicKey);
    const original = await connect(); original.send(undefined, 'device', true, true, true);
    original.send(proof(pair.privateKey, (await original.next('device_challenge')).data.nonce), 'device', true, true, true);
    await original.next('binding_confirm');
    const fence = (server as any).selections.capture('owner', 'device');
    (server as any).streamingMessages.set('orphan-request', { feishuMessageId: 'original-parent', openId: 'owner', deviceId: 'device', threadId: 'thread', selectionFence: fence, elements: [], currentTextContent: '', delegationProgress: new Map(), toolCalls: new Map() });
    original.ws.send(JSON.stringify({ type: 'output_offer', reference: { id: 'a'.repeat(64), sha256: 'b'.repeat(64), messageId: 'orphan-request', threadId: 'thread', taskId: 'orphan-request', generation: 2, name: 'owned-report.csv', size: 12, source: 'workspace', expiresAt: Date.now() + 60_000 } }));
    await original.next('output_registered'); await server.stop();
    if (mismatch !== 'same-source-pending') await fs.rm(path.join(root, 'inline-file-cards'), { recursive: true, force: true });
    await startServer();
    const openId = mismatch === 'other-owner' ? 'other-owner' : 'owner';
    const device = ['other-owner', 'sibling-device'].includes(mismatch) ? 'other-device' : 'device';
    let reconnectPair = pair;
    if (device !== 'device') {
      await (server as any).bindingManager.bindUser(openId, device, 'Other test device'); reconnectPair = keys();
      await (server as any).feishuLongConnHandler.onApproveDeviceKey(openId, device, reconnectPair.publicKey);
    }
    if (mismatch === 'epoch') await (server as any).selections.invalidateDevice(openId, device);
    const resumed = await connect(); resumed.send(undefined, device, true, true, true);
    resumed.send(proof(reconnectPair.privateKey, (await resumed.next('device_challenge')).data.nonce, device), device, true, true, true);
    await resumed.next('binding_confirm');
    const inline = (server as any).inlineFileCards, handler = (server as any).feishuLongConnHandler;
    handler.finalizeStreamingMessage.mockImplementation(async (actual: string) => {
      inline.remember(actual, actual, JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'Recovered body' }] } }));
      await inline.bind(actual, actual); return true;
    });
    resumed.ws.send(JSON.stringify({ type: 'task_resume', messageId: 'orphan-request', openId, threadId: mismatch === 'thread' ? 'other-thread' : 'thread', taskResume: {
      recoveryId: 'recovery', threadName: 'default', backend: 'fake', cwd: root, preview: 'Synthetic task', state: 'completed', attachmentHints: { generation: mismatch === 'generation' ? 3 : 2, names: ['another.csv'] },
    } }));
    const receipt = await resumed.next('task_resume_ack');
    if (mismatch === 'same-source-pending') {
      expect(receipt.success).toBe(true); expect(handler.sendStreamingStart).toHaveBeenCalledOnce();
      expect(JSON.stringify(handler.patchInlineOutputCard.mock.calls)).toContain('owned-report.csv');
      expect(await handler.onOutputFileAction(openId, 'wrong-card', { id: 'a'.repeat(64), op: 'get' })).toContain('unavailable');
      expect(await handler.onOutputFileAction(openId, 'recovery-parent', { id: 'a'.repeat(64), op: 'get' })).toContain('accepted');
    } else {
      expect(JSON.stringify(handler.patchInlineOutputCard.mock.calls)).not.toContain('owned-report.csv');
      expect(receipt.success).toBe(mismatch === 'same-source-orphan');
      expect(handler.sendStreamingStart).toHaveBeenCalledTimes(mismatch === 'same-source-orphan' ? 1 : 0);
    }
    expect((server as any).outputTransfers.state.references).toHaveLength(1);
    expect(handler.sendOutputFile).not.toHaveBeenCalled();
  });

  it.each([true, false])('recovers disabled hints only from an exact pending journal without byte-store initialization (pending=%s)', async pending => {
    await server.stop(); await fs.rm(path.join(root, 'output-files'), { recursive: true, force: true }); await startServer({ enabled: false });
    const epoch = (server as any).selections.capture('owner', 'device').epoch;
    if (pending) {
      const inline = (server as any).inlineFileCards;
      await inline.admit({ messageId: 'disabled-recovery', rootId: 'old-pending-card', openId: 'owner', deviceId: 'device', threadId: 'thread', epoch });
      await inline.hints('device', { messageId: 'disabled-recovery', threadId: 'thread', generation: 2, names: ['report.csv'] }, 'disabled');
    }
    await server.stop(); await startServer({ enabled: false });
    const initialize = vi.spyOn((server as any).outputTransfers, 'initialize');
    const client = await connect(); client.send(undefined, 'device', true, false, true); await client.next('binding_confirm');
    const inline = (server as any).inlineFileCards, handler = (server as any).feishuLongConnHandler;
    handler.finalizeStreamingMessage.mockImplementation(async (actual: string) => {
      inline.remember(actual, actual, JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'Recovered text' }] } }));
      await inline.bind(actual, actual); return true;
    });
    client.ws.send(JSON.stringify({ type: 'task_resume', messageId: 'disabled-recovery', openId: 'owner', threadId: 'thread', taskResume: {
      recoveryId: 'disabled-resume', threadName: 'default', backend: 'fake', cwd: root, preview: 'Synthetic task', state: 'completed', attachmentHints: { generation: 2, names: ['report.csv'] },
    } }));
    expect((await client.next('task_resume_ack')).success).toBe(true);
    const content = JSON.stringify(handler.patchInlineOutputCard.mock.calls);
    if (pending) { expect(content).toContain('report.csv'); expect(content).toContain('File retrieval disabled'); }
    else expect(content).not.toContain('report.csv');
    expect(await handler.onOutputFileAction('owner', 'recovery-parent', { id: 'a'.repeat(64), op: 'get' })).toContain('disabled');
    expect(initialize).not.toHaveBeenCalled(); await expect(fs.stat(path.join(root, 'output-files'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(handler.sendOutputFile).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { enabled: true }, { publicUrl: 'https://legacy-router.test' }])('allows explicit owner enrollment with default reception and no required URL: %j', async files => {
    await server.stop(); await startServer(files);
    const pair = keys(); const nonce = 'a'.repeat(64);
    const response = await fetch(origin + '/api/bind/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'device', devicePublicKey: pair.publicKey, nonce, signature: proof(pair.privateKey, nonce) }) });
    expect(response.status).toBe(200);
    const data: any = await response.json();
    expect(data.deviceAuth).toBe(true);
    expect((server as any).deviceAuth.isCurrent('device', { openId: 'owner', publicKey: pair.publicKey })).toBe(false);
  });
  it('rejects file enrollment when disabled even if an obsolete public URL remains', async () => {
    await server.stop(); await startServer({ enabled: false, publicUrl: 'https://legacy-router.test' });
    const pair = keys(); const nonce = 'a'.repeat(64);
    const response = await fetch(origin + '/api/bind/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'device', devicePublicKey: pair.publicKey, nonce, signature: proof(pair.privateKey, nonce) }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: expect.stringContaining('files.enabled=false') });
    const legacy = await fetch(origin + '/api/bind/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'legacy-device' }) });
    expect(legacy.status).toBe(200);
    const client = await connect(); client.send();
    expect((await client.next('binding_confirm')).data.capabilities?.fileTransferV1).not.toBe(true);
    expect((server as any).connectionHub.isDeviceOnline('device')).toBe(true);
  });
  it('keeps owner-approved device authentication but withholds file capability when disabled', async () => {
    await server.stop(); await startServer({ enabled: false });
    const pair = keys();
    await (server as any).feishuLongConnHandler.onApproveDeviceKey('owner', 'device', pair.publicKey);
    const client = await connect(); client.send();
    client.send(proof(pair.privateKey, (await client.next('device_challenge')).data.nonce));
    expect((await client.next('binding_confirm')).data.capabilities?.fileTransferV1).not.toBe(true);
    expect((server as any).connectionHub.isDeviceOnline('device')).toBe(true);
    expect((server as any).connectionHub.getFileSession('device')).toBeUndefined();
  });
  it('keeps legacy registration but never grants files to self-claimed IDs', async () => {
    const client = await connect(); client.send();
    const response = await client.next('binding_confirm');
    expect(response.data.capabilities?.fileTransferV1).not.toBe(true);
    expect(response.data.capabilities?.outputFilesV1).not.toBe(true);
    expect((server as any).connectionHub.getFileSession('device')).toBeUndefined();
  });
  it('requires proof before replacing a bound connection and rejects cross-connection replay', async () => {
    const pair = keys(); await (server as any).feishuLongConnHandler.onApproveDeviceKey('owner', 'device', pair.publicKey);
    const client = await connect(); client.send();
    const nonce = (await client.next('device_challenge')).data.nonce;
    expect((server as any).connectionHub.isDeviceOnline('device')).toBe(false);
    const signature = proof(pair.privateKey, nonce); client.send(signature);
    expect((await client.next('binding_confirm')).data.capabilities.fileTransferV1).toBe(true);
    expect((await client.next('binding_confirm')).data.capabilities.outputFilesV1).toBe(true);
    expect((server as any).outputSessions.get('device')?.openId).toBe('owner');
    const original = (server as any).connectionHub.getFileSession('device');
    const attacker = await connect(); attacker.send(); await attacker.next('device_challenge');
    expect((server as any).connectionHub.getFileSession('device')).toEqual(original);
    attacker.send(signature); expect((await attacker.next('error')).data.code).toBe('DEVICE_AUTH_REQUIRED');
    expect((server as any).connectionHub.getFileSession('device')).toEqual(original);
  });
  it('requires owner-approved rotation and revocation never downgrades to legacy registration', async () => {
    const old = keys(); const replacement = keys(); const handler = (server as any).feishuLongConnHandler;
    await expect(handler.onApproveDeviceKey('stranger', 'device', old.publicKey)).rejects.toThrow('ownership');
    await handler.onApproveDeviceKey('owner', 'device', old.publicKey);
    const waiting = await connect(); waiting.send(); const challenge = await waiting.next('device_challenge');
    await handler.onApproveDeviceKey('owner', 'device', replacement.publicKey);
    waiting.send(proof(old.privateKey, challenge.data.nonce)); await waiting.next('error');
    const current = await connect(); current.send(); current.send(proof(replacement.privateKey, (await current.next('device_challenge')).data.nonce));
    await current.next('binding_confirm');
    await handler.onRevokeDevice('device');
    expect((server as any).connectionHub.getFileSession('device')).toBeUndefined();
    const legacy = await connect(); legacy.send(); await legacy.next('error');
    expect(legacy.messages.some(m => m.type === 'binding_confirm')).toBe(false);
  });
  it('validates enrollment proofs without trusting a public key submitted over HTTP', async () => {
    const pair = keys(); const nonce = 'a'.repeat(64);
    const response = await fetch(origin + '/api/bind/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'device', devicePublicKey: pair.publicKey, nonce, signature: proof(pair.privateKey, nonce) }) });
    const data: any = await response.json(); expect(data.deviceAuth).toBe(true);
    expect((server as any).deviceAuth.isCurrent('device', { openId: 'owner', publicKey: pair.publicKey })).toBe(false);
    const code = await (server as any).bindingManager.verifyBindingCode(data.bindingCode);
    expect(code.devicePublicKey).toBe(pair.publicKey);
    const bad = await fetch(origin + '/api/bind/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'device', devicePublicKey: pair.publicKey, nonce, signature: 'invalid' }) });
    expect(bad.status).toBe(400);
  });
  it('discards pre-authentication result/control messages', async () => {
    const pair = keys(); await (server as any).deviceAuth.enroll('device', 'owner', pair.publicKey);
    const receive = vi.spyOn((server as any).fileTransfers, 'handleStatus');
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'file_status', fileId: 'a'.repeat(64), status: 'saved' }));
    client.send(); await client.next('device_challenge');
    expect(receive).not.toHaveBeenCalled();
  });
});
