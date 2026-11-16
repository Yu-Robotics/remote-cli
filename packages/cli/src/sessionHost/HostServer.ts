import http from 'http';
import path from 'path';
import { kernelGate } from '../delegation/OwnershipRuntime';
import { randomBytes, randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import type { AddressInfo, Socket } from 'net';
import { HostStore, type HostLimits } from './HostStore';
import { canonical, digest, fields, HOST_CAPABILITIES, HOST_PROTOCOL, HostError, identifier, integer,
  MAX_REQUEST_BYTES, payload, secret, sign, matchesSignature, type FrontendLease, type HostAddress, type HostRuntime,
  type OperationReceipt } from './HostProtocol';

interface Candidate { frontendId: string; epoch: number; token: string; expires: number; deadline: number }
interface Ticket extends Candidate { attached: boolean }
export interface HostOptions {
  /** Private directory. The launcher must provision a private ACL on Windows. */
  directory: string;
  installationId: string;
  /** Random 32-byte hex credential from the trusted launcher; never persisted or sent. */
  secret: string;
  launcherSecret?: string;
  runtime: HostRuntime;
  limits?: HostLimits;
  requestTimeoutMs?: number;
  ticketLifetimeMs?: number;
  maxSockets?: number;
}

/** Retains execution ownership independently of every HTTP frontend connection.
 * The trusted launcher passes address/credential out of band. Losing an HTTP
 * connection does not lose a lease: reconnect with the same lease or a prepared
 * successor ticket. No unauthenticated discovery or automatic lease stealing.
 * Releasing the writer lock proves neither native child exit nor safe restore;
 * the injected runtime adapter must independently qualify that ownership.
 */
export class HostServer {
  private readonly store: HostStore;
  private readonly hostId = randomUUID();
  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private readonly executing = new Set<Promise<void>>();
  private readonly nonces = new Map<string, number>();
  private lease?: FrontendLease;
  private ticket?: Ticket;
  private candidate?: Candidate;
  private activated?: { token: string; lease: FrontendLease };
  private observed = 0;
  private started = false;
  private closing = false;
  private stopped = false;
  private stopping?: Promise<void>;
  private readonly timeout: number;
  private readonly lifetime: number;
  private readonly maxSockets: number;

  constructor(private readonly options: HostOptions) {
    identifier(options.installationId); identifier(options.runtime.authorityId); secret(options.secret);
    if (options.launcherSecret !== undefined) { secret(options.launcherSecret); if (options.launcherSecret === options.secret) throw new HostError('separate_launcher_credential_required'); }
    this.timeout = options.requestTimeoutMs ?? 5000;
    this.lifetime = options.ticketLifetimeMs ?? 30_000;
    this.maxSockets = options.maxSockets ?? 16;
    for (const [n, max] of [[this.timeout, 30_000], [this.lifetime, 120_000], [this.maxSockets, 128]]) {
      if (!Number.isInteger(n) || n < 1 || n > max) throw new HostError('invalid_limit');
    }
    this.store = new HostStore(options.directory, digest(options.installationId + '\0' + options.secret), options.limits);
    this.server = http.createServer((request, response) => { void this.receive(request, response); });
    this.server.headersTimeout = this.timeout;
    this.server.requestTimeout = this.timeout;
    this.server.keepAliveTimeout = 1;
    this.server.maxHeadersCount = 16;
    this.server.on('connection', socket => {
      if (this.closing || this.sockets.size >= this.maxSockets) { socket.destroy(); return; }
      this.sockets.add(socket);
      const deadline = setTimeout(() => socket.destroy(), this.timeout);
      socket.setTimeout(this.timeout, () => socket.destroy());
      socket.once('close', () => { clearTimeout(deadline); this.sockets.delete(socket); });
    });
    this.server.on('clientError', (_error, socket) => socket.destroy());
  }

  async listen(): Promise<HostAddress> {
    if (this.started || this.closing) throw new HostError('host_already_started');
    this.started = true;
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); });
      });
    } catch { this.store.close(); this.closing = true; throw new HostError('host_listen_failed'); }
    return { port: (this.server.address() as AddressInfo).port, hostId: this.hostId, installationId: this.options.installationId };
  }

  /** Local owner API only; frontend detach and socket close never call this. */
  stop(timeoutMs = 5000): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return Promise.reject(new HostError('invalid_limit'));
    if (this.stopped) return Promise.resolve();
    if (this.stopping) return this.stopping;
    try { this.options.runtime.assertCanStop?.(); } catch (error) { return Promise.reject(error); }
    this.closing = true;
    for (const socket of this.sockets) socket.destroy();
    const closed = new Promise<void>(resolve => this.server.close(() => resolve()));
    const work = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => { await this.options.runtime.stop(); await Promise.all([...this.executing]); await closed; })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HostError('host_stop_unconfirmed')), timeoutMs); }),
        ]);
        this.store.close(); this.stopped = true;
      } finally { if (timer) clearTimeout(timer); }
    })();
    this.stopping = work;
    // Failed stop retains the writer lock. The owner may explicitly retry after
    // its runtime settles; no new host may assume native retirement from a timeout.
    void work.finally(() => { if (!this.stopped) this.stopping = undefined; }).catch(() => {});
    return work;
  }

  private async receive(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let authenticated: { nonce: string; timestamp: string; key: string; launcher: boolean } | undefined;
    const answer = (status: number, value: unknown) => {
      const data = JSON.stringify(value);
      if (!response.destroyed) {
        response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close',
          ...(authenticated ? { 'x-session-host-signature': sign(authenticated.key, 'response', authenticated.nonce, authenticated.timestamp, data) } : {}) });
        response.end(data);
      }
    };
    const deadline = setTimeout(() => request.destroy(), this.timeout);
    try {
      if (this.closing) throw new HostError('host_closing');
      if (request.method !== 'POST' || request.url !== '/v1' || request.headers['content-type'] !== 'application/json') throw new HostError('invalid_transport');
      const nonce = request.headers['x-session-host-nonce'];
      const timestamp = request.headers['x-session-host-time'];
      if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce) || typeof timestamp !== 'string'
        || !/^\d{1,16}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 30_000) throw new HostError('unauthorized');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) throw new HostError('request_too_large');
        chunks.push(Buffer.from(chunk));
      }
      const data = Buffer.concat(chunks).toString('utf8');
      const launcher = !!this.options.launcherSecret && matchesSignature(request.headers['x-session-host-signature'], sign(this.options.launcherSecret, 'request', nonce, timestamp, data));
      const key = launcher ? this.options.launcherSecret! : this.options.secret;
      if (!matchesSignature(request.headers['x-session-host-signature'], sign(key, 'request', nonce, timestamp, data))) throw new HostError('unauthorized');
      authenticated = { nonce, timestamp, key, launcher };
      const now = performance.now();
      for (const [key, expiry] of this.nonces) if (expiry <= now) this.nonces.delete(key);
      if (this.nonces.has(nonce)) throw new HostError('replayed_request');
      if (this.nonces.size >= 1024) throw new HostError('authentication_capacity');
      this.nonces.set(nonce, now + 65_000);
      const envelope: unknown = JSON.parse(data);
      fields(envelope, ['protocol', 'installationId', 'hostId', 'method', 'body']);
      if (envelope.protocol !== HOST_PROTOCOL || envelope.installationId !== this.options.installationId || envelope.hostId !== this.hostId) throw new HostError('host_identity_mismatch');
      if (typeof envelope.method !== 'string') throw new HostError('invalid_request');
      answer(200, { ok: true, protocol: HOST_PROTOCOL, hostId: this.hostId, value: await this.route(envelope.method, envelope.body, authenticated.launcher) });
    } catch (error) {
      // Neither native exception strings nor credentials/addresses cross this boundary.
      answer(error instanceof HostError && error.code === 'unauthorized' ? 401 : 400,
        { ok: false, code: error instanceof HostError ? error.code : 'invalid_request' });
      request.resume();
    } finally { clearTimeout(deadline); }
  }

  private route(method: string, body: unknown, launcher = false): unknown {
    if (this.closing) throw new HostError('host_closing');
    if (method === 'hello') {
      fields(body, []);
      return { capabilities: HOST_CAPABILITIES, authorityId: this.options.runtime.authorityId,
        acceptedThrough: this.store.snapshot().acceptedThrough, retiredThrough: this.store.snapshot().retiredThrough, epoch: this.store.snapshot().epoch, acknowledged: this.store.snapshot().acknowledged,
        active: !!this.lease, storageHealthy: !this.store.failed };
    }
    if (this.store.failed) throw new HostError('storage_unavailable');
    if (method === 'recoverFrontend') {
      fields(body, ['frontendId', 'epoch']); identifier(body.frontendId); integer(body.epoch);
      if (!launcher) throw new HostError('launcher_authority_required');
      if (body.epoch !== this.store.snapshot().epoch) throw new HostError('stale_epoch');
      const proof = kernelGate(path.join(this.options.directory, 'frontend.lock'));
      if (!proof) throw new HostError('frontend_still_alive');
      try {
        this.store.change(state => { state.epoch++; });
        this.lease = { frontendId: body.frontendId, epoch: this.store.snapshot().epoch, token: randomBytes(32).toString('hex') };
        this.ticket = undefined; this.candidate = undefined; this.activated = undefined;
        this.observed = this.store.snapshot().acknowledged;
        return this.lease;
      } finally { proof.close(); }
    }
    if (launcher) throw new HostError('frontend_authority_required');
    if (method === 'inspect') {
      fields(body, ['lease', 'operation', 'args']); this.requireLease(body.lease); identifier(body.operation);
      if (!this.options.runtime.inspect) throw new HostError('runtime_inspection_unavailable');
      return this.options.runtime.inspect(body.operation, payload(body.args));
    }
    if (method === 'prepare') {
      fields(body, ['lease', 'successorId']); this.requireLease(body.lease); identifier(body.successorId);
      if (body.successorId === this.lease!.frontendId) throw new HostError('invalid_successor');
      if (this.ticket && this.ticket.deadline > performance.now()) {
        if (this.ticket.frontendId !== body.successorId || this.ticket.attached) throw new HostError('replacement_pending');
        return { ticket: this.ticket.token, expires: this.ticket.expires };
      }
      this.candidate = undefined;
      this.ticket = { frontendId: body.successorId, epoch: this.lease!.epoch, token: randomBytes(32).toString('hex'),
        expires: Date.now() + this.lifetime, deadline: performance.now() + this.lifetime, attached: false };
      return { ticket: this.ticket.token, expires: this.ticket.expires };
    }
    if (method === 'attach') {
      fields(body, ['frontendId', 'epoch'], ['ticket']); identifier(body.frontendId); integer(body.epoch);
      if (body.epoch !== this.store.snapshot().epoch) throw new HostError('stale_epoch');
      if (this.candidate && this.candidate.deadline > performance.now()) throw new HostError('replacement_pending');
      if (this.lease) {
        if (!this.ticket || this.ticket.attached || this.ticket.token !== body.ticket || this.ticket.frontendId !== body.frontendId
          || this.ticket.epoch !== body.epoch || this.ticket.deadline <= performance.now()) throw new HostError('invalid_ticket');
        this.ticket.attached = true;
      } else if (body.ticket !== undefined) throw new HostError('invalid_ticket');
      this.candidate = { frontendId: body.frontendId, epoch: body.epoch, token: randomBytes(32).toString('hex'),
        expires: this.lease ? this.ticket!.expires : Date.now() + this.lifetime,
        deadline: this.lease ? this.ticket!.deadline : performance.now() + this.lifetime };
      return { attachment: this.candidate.token, expires: this.candidate.expires };
    }
    if (method === 'activate') {
      fields(body, ['frontendId', 'epoch', 'attachment']); identifier(body.frontendId); integer(body.epoch); secret(body.attachment);
      if (this.activated?.token === body.attachment && this.lease?.frontendId === body.frontendId
        && this.activated.lease.epoch === this.lease.epoch && body.epoch + 1 === this.lease.epoch) return this.lease;
      const candidate = this.candidate;
      if (!candidate || candidate.token !== body.attachment || candidate.frontendId !== body.frontendId
        || candidate.epoch !== body.epoch || candidate.epoch !== this.store.snapshot().epoch || candidate.deadline <= performance.now()) throw new HostError('invalid_attachment');
      this.store.change(state => { state.epoch++; });
      this.lease = { frontendId: candidate.frontendId, epoch: this.store.snapshot().epoch, token: randomBytes(32).toString('hex') };
      this.activated = { token: candidate.token, lease: this.lease };
      this.candidate = undefined; this.ticket = undefined; this.observed = this.store.snapshot().acknowledged;
      return this.lease;
    }
    if (method === 'detach') {
      fields(body, ['lease']); this.requireLease(body.lease);
      this.store.change(state => { state.epoch++; });
      this.lease = undefined; this.candidate = undefined; this.ticket = undefined; this.activated = undefined;
      return { detached: true };
    }
    if (method === 'submit') {
      fields(body, ['lease', 'requestId', 'operation', 'args'], ['requestSequence']); this.requireLease(body.lease);
      identifier(body.requestId); identifier(body.operation);
      const args = payload(body.args);
      const hash = digest(canonical([body.operation, args]));
      const state = this.store.snapshot();
      let requestSequence: number | undefined;
      if (body.requestSequence !== undefined) {
        integer(body.requestSequence); requestSequence = body.requestSequence;
        if (body.requestId !== `sequenced-${requestSequence}`) throw new HostError('invalid_request_sequence');
        if (requestSequence <= state.retiredThrough) throw new HostError('request_retired');
      } else if (body.requestId.startsWith('sequenced-')) throw new HostError('invalid_request_sequence');
      const previous = state.operations.find(op => op.requestId === body.requestId);
      if (previous) {
        if (previous.requestSequence !== requestSequence) throw new HostError('invalid_request_sequence');
        if (previous.digest !== hash) throw new HostError('request_digest_mismatch');
        return this.receipt(previous);
      }
      if (requestSequence !== undefined && requestSequence !== state.acceptedThrough + 1) throw new HostError('request_sequence_gap');
      if (state.operations.length >= this.store.limits.operations
        || state.events.length + state.operations.filter(op => op.status === 'pending').length >= this.store.limits.events) throw new HostError('capacity_exhausted');
      const accepted: OperationReceipt = { requestId: body.requestId, status: 'pending' };
      this.store.change(next => { next.operations.push({ ...accepted, digest: hash, ...(requestSequence !== undefined ? { requestSequence } : {}) }); if (requestSequence !== undefined) next.acceptedThrough = requestSequence; });
      const operation = { requestId: body.requestId, method: body.operation, args };
      // Dispatch only this freshly committed acceptance; reconnects never enter here.
      const work = Promise.resolve().then(async () => {
        let completed: OperationReceipt;
        try {
          const result = await this.options.runtime.execute(operation);
          try { completed = { ...accepted, status: 'completed', result: payload(result) }; }
          catch { completed = { ...accepted, status: 'failed', error: 'invalid_runtime_result' }; }
        } catch { completed = { ...accepted, status: 'failed', error: 'runtime_failed' }; }
        this.store.change(next => {
          Object.assign(next.operations.find(op => op.requestId === operation.requestId)!, completed);
          this.store.addEvent(next, completed);
        });
      }).catch(() => { /* Store faults retain pending durable evidence, never redispatch. */ });
      this.executing.add(work);
      void work.finally(() => this.executing.delete(work));
      return accepted;
    }
    if (method === 'status') {
      fields(body, ['lease', 'requestId']); this.requireLease(body.lease); identifier(body.requestId);
      const operation = this.store.snapshot().operations.find(op => op.requestId === body.requestId);
      if (!operation) throw new HostError('request_not_found');
      return this.receipt(operation);
    }
    if (method === 'events') {
      fields(body, ['lease', 'after']); this.requireLease(body.lease); integer(body.after);
      const after = body.after;
      const state = this.store.snapshot();
      if (after < state.acknowledged || after > state.sequence) throw new HostError('cursor_unavailable');
      // Replaying from an older cursor is harmless; skipping unseen output cannot
      // grant ACK authority. Each new lease must observe the unacknowledged prefix.
      if (after > this.observed) throw new HostError('cursor_not_observed');
      this.observed = state.sequence;
      return { acknowledged: state.acknowledged, through: state.sequence, events: state.events.filter(event => event.sequence > after) };
    }
    if (method === 'ack') {
      fields(body, ['lease', 'through']); this.requireLease(body.lease); integer(body.through);
      const through = body.through;
      if (through > this.observed || through < this.store.snapshot().acknowledged) throw new HostError('ack_not_observed');
      this.store.change(state => { state.acknowledged = through; state.events = state.events.filter(event => event.sequence > through); this.store.compactAcknowledged(state); });
      return { acknowledged: through };
    }
    throw new HostError('unknown_method');
  }

  private receipt(operation: OperationReceipt): OperationReceipt {
    const { requestId, status, result, error } = operation;
    return { requestId, status, ...(result !== undefined ? { result } : {}), ...(error ? { error } : {}) };
  }
  private requireLease(value: unknown): void {
    fields(value, ['frontendId', 'epoch', 'token']);
    if (!this.lease || value.frontendId !== this.lease.frontendId || value.epoch !== this.lease.epoch || value.token !== this.lease.token) throw new HostError('stale_lease');
  }
}
