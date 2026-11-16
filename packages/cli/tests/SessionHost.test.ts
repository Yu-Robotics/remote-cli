import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import net from 'net';
import { once } from 'events';
import { randomBytes } from 'crypto';
import { performance } from 'perf_hooks';
import { HostServer, type HostOptions } from '../src/sessionHost/HostServer';
import { HostClient } from '../src/sessionHost/HostClient';
import { HostStore } from '../src/sessionHost/HostStore';
import { kernelGate } from '../src/delegation/OwnershipRuntime';
import { canonical, digest, HOST_PROTOCOL, payload, sign, type FrontendLease, type HostAddress, type Json } from '../src/sessionHost/HostProtocol';

let root: string;
let credential: string;
const hosts: HostServer[] = [];
const clients: HostClient[] = [];
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-host-')));
  credential = randomBytes(32).toString('hex');
});
afterEach(async () => {
  vi.restoreAllMocks();
  clients.splice(0).forEach(client => client.close());
  for (const host of hosts.splice(0)) await host.stop();
  fs.rmSync(root, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function client(address: HostAddress, key = credential) {
  const value = new HostClient(address, key); clients.push(value); return value;
}
async function fixture(overrides: Partial<HostOptions> = {}) {
  const execute = vi.fn(async () => ({ output: 'synthetic result' }));
  const stop = vi.fn(async () => {});
  const host = new HostServer({ directory: root, installationId: 'fixture-installation', secret: credential,
    runtime: { authorityId: 'fixture-native-owner', execute, stop }, ...overrides });
  hosts.push(host);
  const address = await host.listen();
  const a = client(address);
  return { host, address, a, execute, stop };
}
async function activate(a: HostClient, id = 'frontend-a'): Promise<FrontendLease> {
  const { epoch } = await a.hello();
  const { attachment } = await a.attach(id, epoch);
  return a.activate(id, epoch, attachment);
}
async function terminal(a: HostClient, lease: FrontendLease, id = 'request-1') {
  await vi.waitFor(async () => expect((await a.status(lease, id)).status).not.toBe('pending'));
  return a.status(lease, id);
}
function signedHeaders(body: string, key = credential) {
  const nonce = randomBytes(32).toString('hex'); const timestamp = String(Date.now());
  return { 'x-session-host-nonce': nonce, 'x-session-host-time': timestamp,
    'x-session-host-signature': sign(key, 'request', nonce, timestamp, body), 'content-type': 'application/json' };
}
function raw(address: HostAddress, body: string, headers = signedHeaders(body), method = 'POST', url = '/v1') {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: url, method, agent: false,
      headers }, res => {
      let data = ''; res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(body);
  });
}
function envelope(address: HostAddress, method: string, body: unknown) {
  return JSON.stringify({ ...address, port: undefined, protocol: HOST_PROTOCOL, method, body });
}

describe('retained host lifecycle', () => {
  it('compacts sequenced ACK receipts across repeated capacity cycles while permanently fencing old sequences', async () => {
    const { a, execute } = await fixture({ limits: { operations: 4, events: 4 } });
    const lease = await activate(a);
    for (let sequence = 1; sequence <= 12; sequence++) {
      await a.submitSequenced(lease, sequence, 'run', { sequence });
      await terminal(a, lease, `sequenced-${sequence}`);
      const events = await a.events(lease, sequence - 1); await a.ack(lease, events.through);
    }
    expect(execute).toHaveBeenCalledTimes(12);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).operations).toEqual([]);
    expect(await a.hello()).toMatchObject({ acceptedThrough: 12, retiredThrough: 12 });
    await expect(a.submitSequenced(lease, 1, 'run', { changed: true })).rejects.toThrow('request_retired');
    await expect(a.submitSequenced(lease, 14, 'run', null)).rejects.toThrow('request_sequence_gap');
    await expect(a.submit(lease, 'sequenced-13', 'run', null)).rejects.toThrow('invalid_request_sequence');
  });

  it('retains a pending prefix through out-of-order ACKs and persists the replay watermark across restart', async () => {
    const held = deferred<Json>();
    const execute = vi.fn(async (operation: { requestId: string }) => operation.requestId === 'sequenced-1' ? held.promise : null);
    const first = await fixture({ runtime: { authorityId: 'fixture-owner', execute, stop: async () => { held.resolve(null); } } });
    const lease = await activate(first.a);
    await first.a.submitSequenced(lease, 1, 'run', null);
    await first.a.submitSequenced(lease, 2, 'run', null); await terminal(first.a, lease, 'sequenced-2');
    const event = await first.a.events(lease, 0); await first.a.ack(lease, event.through);
    expect(await first.a.hello()).toMatchObject({ retiredThrough: 0 });
    expect((await first.a.submitSequenced(lease, 2, 'run', null)).status).toBe('completed');
    held.resolve(null); await terminal(first.a, lease, 'sequenced-1');
    const later = await first.a.events(lease, event.through); await first.a.ack(lease, later.through);
    expect(await first.a.hello()).toMatchObject({ retiredThrough: 2 });
    await first.host.stop();
    const second = await fixture(); const successor = await activate(second.a);
    await expect(second.a.submitSequenced(successor, 2, 'run', null)).rejects.toThrow('request_retired');
    await second.a.submitSequenced(successor, 3, 'run', null); await terminal(second.a, successor, 'sequenced-3');
    expect(second.execute).toHaveBeenCalledTimes(1);
  });

  it('loads prior bounded receipt schema without redispatching legacy acceptance', async () => {
    const file = path.join(root, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, binding: digest('fixture-installation\0' + credential), epoch: 5,
      sequence: 0, acknowledged: 0, events: [], operations: [{ requestId: 'legacy', digest: digest(canonical(['run', null])), status: 'pending' }] }), { mode: 0o600 });
    const { a, execute } = await fixture(); const lease = await activate(a);
    expect(await a.submit(lease, 'legacy', 'run', null)).toMatchObject({ status: 'unknown', error: 'host_restarted' });
    expect(await a.hello()).toMatchObject({ acceptedThrough: 0, retiredThrough: 0 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires independent launcher authority and a released frontend kernel lock for crash recovery', async () => {
    const launcherSecret = randomBytes(32).toString('hex');
    const { address, a, execute } = await fixture({ launcherSecret });
    const admin = client(address, launcherSecret); const hello = await admin.hello();
    await expect(a.recoverFrontend('a', hello.epoch)).rejects.toThrow('launcher_authority_required');
    const old = await admin.recoverFrontend('a', hello.epoch);
    const life = kernelGate(path.join(root, 'frontend.lock'))!;
    try { await expect(admin.recoverFrontend('b', old.epoch)).rejects.toThrow('frontend_still_alive'); }
    finally { life.close(); }
    const next = await admin.recoverFrontend('b', old.epoch);
    await expect(admin.recoverFrontend('c', old.epoch)).rejects.toThrow('stale_epoch');
    await expect(a.submit(old, 'stale', 'run', null)).rejects.toThrow('stale_lease');
    await a.submit(next, 'accepted', 'run', null);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('replaces a disconnected frontend without cancelling or redispatching accepted work', async () => {
    const done = deferred<Json>(); const execute = vi.fn(() => done.promise); const stop = vi.fn(async () => { done.resolve(null); });
    const { address, a } = await fixture({ runtime: { authorityId: 'stable-native-owner', execute, stop } });
    const leaseA = await activate(a);
    expect(await a.submit(leaseA, 'request-1', 'run', { b: 2, a: 1 })).toMatchObject({ status: 'pending' });
    const ticket = await a.prepare(leaseA, 'frontend-b');
    expect(await a.prepare(leaseA, 'frontend-b')).toEqual(ticket);
    a.close();
    const b = client(address);
    const attachment = await b.attach('frontend-b', leaseA.epoch, ticket.ticket);
    const leaseB = await b.activate('frontend-b', leaseA.epoch, attachment.attachment);
    expect(await b.activate('frontend-b', leaseA.epoch, attachment.attachment)).toEqual(leaseB);
    expect((await b.hello()).authorityId).toBe('stable-native-owner');
    expect(await b.submit(leaseB, 'request-1', 'run', { a: 1, b: 2 })).toMatchObject({ status: 'pending' });
    await expect(b.submit(leaseA, 'stale', 'run', null)).rejects.toThrow('stale_lease');
    await expect(b.submit(leaseB, 'request-1', 'run', { a: 2 })).rejects.toThrow('digest_mismatch');
    expect(execute).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
    done.resolve({ output: 'retained output' });
    expect(await terminal(b, leaseB)).toMatchObject({ status: 'completed', result: { output: 'retained output' } });
    const first = await b.events(leaseB, 0);
    expect(first.events).toHaveLength(1);
    expect(await b.events(leaseB, 0)).toEqual(first);
    await b.ack(leaseB, first.through);
    expect((await b.events(leaseB, first.through)).events).toEqual([]);
    expect(await b.submit(leaseB, 'request-1', 'run', { a: 1, b: 2 })).toMatchObject({ status: 'completed' });
    expect(execute).toHaveBeenCalledTimes(1);
    await b.detach(leaseB);
    await expect(b.detach(leaseB)).rejects.toThrow('stale_lease');
    const leaseC = await activate(b, 'frontend-c'); expect(leaseC.epoch).toBeGreaterThan(leaseB.epoch);
  });

  it('rejects concurrent/expired replacement tickets while retaining the incumbent', async () => {
    const { a } = await fixture({ ticketLifetimeMs: 5000 }); const lease = await activate(a);
    const ticket = await a.prepare(lease, 'frontend-b');
    await expect(a.prepare(lease, 'frontend-c')).rejects.toThrow('replacement_pending');
    await expect(a.prepare(lease, 'frontend-a')).rejects.toThrow('invalid_successor');
    await expect(a.attach('frontend-c', lease.epoch, ticket.ticket)).rejects.toThrow('invalid_ticket');
    const contenders = await Promise.allSettled([a.attach('frontend-b', lease.epoch, ticket.ticket), a.attach('frontend-b', lease.epoch, ticket.ticket)]);
    expect(contenders.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const attachment = (contenders.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ attachment: string }>).value;
    const now = performance.now(); vi.spyOn(performance, 'now').mockReturnValue(now + 6000);
    await expect(a.activate('frontend-b', lease.epoch, attachment.attachment)).rejects.toThrow('invalid_attachment');
    await expect(a.attach('frontend-b', lease.epoch, ticket.ticket)).rejects.toThrow('invalid_ticket');
    expect((await a.submit(lease, 'incumbent', 'run', null)).status).toBe('pending');
    const replacement = await a.prepare(lease, 'frontend-c'); expect(replacement.ticket).not.toBe(ticket.ticket);
  });

  it('checks exact installation/incarnation/auth before any lifecycle or runtime action', async () => {
    const { a, address, execute } = await fixture();
    await expect(client(address, randomBytes(32).toString('hex')).hello()).rejects.toThrow('unauthorized');
    await expect(client({ ...address, hostId: 'other-host' }).hello()).rejects.toThrow('identity_mismatch');
    await expect(client({ ...address, installationId: 'other-installation' }).hello()).rejects.toThrow('identity_mismatch');
    const hello = await a.hello();
    await expect(a.attach('a', hello.epoch + 1)).rejects.toThrow('stale_epoch');
    await expect(a.attach('a', hello.epoch, 'invented')).rejects.toThrow('invalid_ticket');
    const lease = await activate(a);
    await expect(a.submit({ ...lease, token: randomBytes(32).toString('hex') }, 'x', 'run', null)).rejects.toThrow('stale_lease');
    expect(execute).not.toHaveBeenCalled();
    const stored = fs.readFileSync(path.join(root, 'state.json'), 'utf8');
    expect(stored).not.toContain(credential); expect(stored).not.toContain(lease.token); expect(stored).not.toContain(address.hostId);
  });

  it('reserves terminal output capacity before dispatch and retains receipt tombstones after ACK', async () => {
    const done = deferred<Json>(); const execute = vi.fn(() => done.promise);
    const { a } = await fixture({ limits: { operations: 2, events: 1 }, runtime: { authorityId: 'capacity-owner', execute, stop: async () => { done.resolve(null); } } });
    const lease = await activate(a);
    await a.submit(lease, 'one', 'run', null);
    await expect(a.submit(lease, 'two', 'run', null)).rejects.toThrow('capacity_exhausted');
    done.resolve('one'); await terminal(a, lease, 'one');
    await expect(a.ack(lease, 1)).rejects.toThrow('ack_not_observed');
    await expect(a.events(lease, 1)).rejects.toThrow('cursor_not_observed');
    await expect(a.events(lease, 2)).rejects.toThrow('cursor_unavailable');
    await a.events(lease, 0); await a.ack(lease, 1);
    await expect(a.events(lease, 0)).rejects.toThrow('cursor_unavailable');
    await a.submit(lease, 'two', 'run', null); await terminal(a, lease, 'two');
    await a.events(lease, 1); await a.ack(lease, 2);
    await expect(a.submit(lease, 'three', 'run', null)).rejects.toThrow('capacity_exhausted');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('keeps replay events and stable IDs across graceful restart, never rerunning completed requests', async () => {
    const first = await fixture(); const lease = await activate(first.a);
    await first.a.submit(lease, 'one', 'run', null); await terminal(first.a, lease, 'one');
    const events = await first.a.events(lease, 0);
    await first.host.stop();
    const second = await fixture(); const lease2 = await activate(second.a);
    expect(lease2.epoch).toBeGreaterThan(lease.epoch);
    expect(second.address.hostId).not.toBe(first.address.hostId);
    expect(await second.a.events(lease2, 0)).toEqual(events);
    expect((await second.a.submit(lease2, 'one', 'run', null)).status).toBe('completed');
    expect(second.execute).not.toHaveBeenCalled();
    await second.a.ack(lease2, events.through);
  });

  it('fences writes and does not dispatch when durable acceptance fails', async () => {
    const { a, execute } = await fixture(); const lease = await activate(a);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('synthetic IO failure'); });
    await expect(a.submit(lease, 'one', 'run', null)).rejects.toThrow('storage_unavailable');
    rename.mockRestore();
    expect(execute).not.toHaveBeenCalled(); expect((await a.hello()).storageHealthy).toBe(false);
    await expect(a.submit(lease, 'one', 'run', null)).rejects.toThrow('storage_unavailable');
  });

  it('does not repeat an accepted effect when the frontend loses the acceptance reply', async () => {
    const done = deferred<Json>(); let request!: http.ClientRequest;
    const execute = vi.fn(() => { request.destroy(new Error('Synthetic reply loss')); return done.promise; });
    const { address, a } = await fixture({ runtime: { authorityId: 'reply-loss-owner', execute, stop: async () => { done.resolve(null); } } });
    const lease = await activate(a);
    await new Promise<void>(resolve => {
      const data = envelope(address, 'submit', { lease, requestId: 'lost-reply', operation: 'run', args: null });
      request = http.request({ hostname: '127.0.0.1', port: address.port, path: '/v1', method: 'POST', agent: false,
        headers: signedHeaders(data) });
      request.once('error', () => resolve());
      request.end(data);
    });
    expect((await a.status(lease, 'lost-reply')).status).toBe('pending');
    expect((await a.submit(lease, 'lost-reply', 'run', null)).status).toBe('pending');
    done.resolve('finished once');
    expect(await terminal(a, lease, 'lost-reply')).toMatchObject({ result: 'finished once' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('never redispatches acceptance whose atomic replacement committed before reporting a write error', async () => {
    const first = await fixture(); const lease = await activate(first.a);
    const rename = fs.renameSync;
    const fault = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => { rename(source, target); throw new Error('Synthetic post-commit failure'); });
    await expect(first.a.submit(lease, 'ambiguous-write', 'run', null)).rejects.toThrow('storage_unavailable');
    fault.mockRestore(); expect(first.execute).not.toHaveBeenCalled(); await first.host.stop();
    const second = await fixture(); const next = await activate(second.a);
    expect(await second.a.submit(next, 'ambiguous-write', 'run', null)).toMatchObject({ status: 'unknown', error: 'host_restarted' });
    expect(second.execute).not.toHaveBeenCalled();
  });

  it('preserves unknown outcome after completion persistence fails and never redispatches on restart', async () => {
    const done = deferred<Json>();
    const first = await fixture({ runtime: { authorityId: 'io-owner', execute: () => done.promise, stop: async () => { done.resolve(null); } } });
    const lease = await activate(first.a); await first.a.submit(lease, 'one', 'run', null);
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('synthetic IO failure'); });
    done.resolve({ result: 'native effect already happened' });
    await vi.waitFor(async () => expect((await first.a.hello()).storageHealthy).toBe(false));
    sync.mockRestore(); await first.host.stop();
    const second = await fixture(); const next = await activate(second.a);
    expect(await second.a.submit(next, 'one', 'run', null)).toMatchObject({ status: 'unknown', error: 'host_restarted' });
    expect((await second.a.events(next, 0)).events[0]).toMatchObject({ requestId: 'one', status: 'unknown' });
    expect(second.execute).not.toHaveBeenCalled();
  });

  it('does not expose runtime exceptions and bounds runtime result payloads', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('synthetic-private-detail')).mockResolvedValueOnce('x'.repeat(17000)).mockResolvedValueOnce(undefined);
    const { a } = await fixture({ runtime: { authorityId: 'error-owner', execute, stop: async () => {} } });
    const lease = await activate(a);
    for (const [id, error] of [['throw', 'runtime_failed'], ['large', 'invalid_runtime_result'], ['undefined', 'invalid_runtime_result']]) {
      await a.submit(lease, id, 'run', null);
      expect(await terminal(a, lease, id)).toEqual({ requestId: id, status: 'failed', error });
    }
    expect(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).not.toContain('synthetic-private-detail');
    await expect(a.status(lease, 'absent')).rejects.toThrow('request_not_found');
    await expect(a.submit(lease, 'large-input', 'run', 'x'.repeat(17000))).rejects.toThrow('payload_too_large');
  });

  it('retains the exclusive writer until explicit runtime shutdown is confirmed', async () => {
    const done = deferred<void>(); let settle = false;
    const { host } = await fixture({ runtime: { authorityId: 'stop-owner', execute: async () => null, stop: async () => { if (!settle) await done.promise; } } });
    const stopping = host.stop(20); expect(host.stop(20)).toBe(stopping);
    await expect(stopping).rejects.toThrow('host_stop_unconfirmed');
    expect(() => new HostStore(root, digest('fixture-installation\0' + credential))).toThrow('host_already_owned');
    settle = true; done.resolve(); await host.stop(); await host.stop();
    const replacement = new HostStore(root, digest('fixture-installation\0' + credential)); replacement.close();
  });
});

describe('local transport and store validation', () => {
  it('authenticates both directions and rejects captured or modified request frames', async () => {
    const { address, execute } = await fixture();
    const body = envelope(address, 'hello', {}); const headers = signedHeaders(body);
    expect((await raw(address, body, headers)).body.ok).toBe(true);
    expect((await raw(address, body, headers)).body.code).toBe('replayed_request');
    expect((await raw(address, body + ' ', signedHeaders(body))).body.code).toBe('unauthorized');
    expect((await raw(address, body, { ...signedHeaders(body), 'x-session-host-time': '1' })).body.code).toBe('unauthorized');
    let capturedHeaders = '';
    const impostor = http.createServer((request, response) => {
      // Knowing the requested host ID is not enough to forge host authority.
      capturedHeaders = JSON.stringify(request.headers);
      request.resume(); response.end(JSON.stringify({ ok: true, protocol: 1, hostId: address.hostId, value: {} }));
    });
    await new Promise<void>(resolve => impostor.listen(0, '127.0.0.1', resolve));
    try {
      await expect(client({ ...address, port: (impostor.address() as net.AddressInfo).port }).hello()).rejects.toThrow('unauthenticated_response');
      expect(capturedHeaders).not.toContain(credential);
    } finally { await new Promise<void>(resolve => impostor.close(() => resolve())); }
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects malformed, oversized, unexpected and stale wire frames without dispatch', async () => {
    const { address, execute, a, host } = await fixture();
    for (const [body, method, url, code] of [
      ['{', 'POST', '/v1', 'invalid_request'],
      [envelope(address, 'hello', { extra: true }), 'POST', '/v1', 'invalid_request'],
      [envelope(address, 'absent', {}), 'POST', '/v1', 'unknown_method'],
      ['{}', 'GET', '/v1', 'invalid_transport'], ['{}', 'POST', '/wrong', 'invalid_transport'],
      [JSON.stringify({ protocol: 2, installationId: address.installationId, hostId: address.hostId, method: 'hello', body: {} }), 'POST', '/v1', 'host_identity_mismatch'],
      ['x'.repeat(65537), 'POST', '/v1', 'request_too_large'],
    ]) expect((await raw(address, body, undefined, method, url)).body.code).toBe(code);
    expect(execute).not.toHaveBeenCalled();
    await expect(a.submit({ frontendId: 'a', token: '', epoch: 0 }, 'x', 'run', 'x'.repeat(70000))).rejects.toThrow('request_too_large');
    await expect(host.listen()).rejects.toThrow('host_already_started');
    a.close(); await expect(a.hello()).rejects.toThrow('client_closed');
  });

  it('bounds idle sockets and closes incomplete requests without affecting the runtime', async () => {
    const { address, stop } = await fixture({ maxSockets: 1, requestTimeoutMs: 60 });
    const first = net.connect(address.port, '127.0.0.1'); first.on('error', () => {});
    const firstClosed = once(first, 'close');
    await once(first, 'connect');
    first.write('POST /v1 HTTP/1.1\r\n');
    const second = net.connect(address.port, '127.0.0.1'); second.on('error', () => {});
    await once(second, 'close'); await firstClosed;
    expect(stop).not.toHaveBeenCalled();
    expect((await client(address).hello()).storageHealthy).toBe(true);
  });

  it('reports uncertain outcome for a lost reply and close; it never retries a transport request', async () => {
    const server = http.createServer((_req, res) => { res.on('error', () => {}); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const sockets = new Set<net.Socket>(); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    const addr = { port: (server.address() as net.AddressInfo).port, hostId: 'test-host', installationId: 'test-installation' };
    const a = new HostClient(addr, credential, 20);
    try {
      await expect(a.hello()).rejects.toThrow('transport_outcome_unknown');
      const pending = a.hello(); a.close(); await expect(pending).rejects.toThrow('client_closed');
    } finally { a.close(); sockets.forEach(s => s.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('validates canonical payloads and refuses unsafe/corrupt/rebound stores', () => {
    expect(canonical({ b: 2, a: [true, null] })).toBe('{"a":[true,null],"b":2}');
    for (const value of [undefined, Infinity, new Date(), { x: undefined }]) expect(() => payload(value)).toThrow();
    let deep: any = null; for (let i = 0; i < 18; i++) deep = [deep]; expect(() => payload(deep)).toThrow();
    expect(() => new HostClient({ port: 0, hostId: 'x', installationId: 'y' }, credential)).toThrow('invalid_address');
    expect(() => new HostClient({ port: 1, hostId: 'x', installationId: 'y' }, 'bad')).toThrow('invalid_secret');
    expect(() => new HostStore(root, digest('fixture'), { operations: 0, events: 1 })).toThrow('invalid_capacity');
    const store = new HostStore(root, digest('fixture'));
    expect(() => store.change(state => { state.epoch = -1; })).toThrow('invalid_integer');
    store.close(); store.close(); expect(() => store.change(() => {})).toThrow('storage_unavailable');
    expect(() => new HostStore(root, digest('different'))).toThrow('invalid_store');
    fs.writeFileSync(path.join(root, 'state.json'), '{');
    expect(() => new HostStore(root, digest('fixture'))).toThrow();
    fs.rmSync(path.join(root, 'state.json')); fs.mkdirSync(path.join(root, 'state.json'));
    expect(() => new HostStore(root, digest('fixture'))).toThrow('unsafe_store_file');
  });
});
