import http from 'http';
import { randomBytes } from 'crypto';
import { HOST_PROTOCOL, HostError, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, object, secret, sign, matchesSignature,
  type FrontendLease, type HostAddress, type HostEvent, type Json, type OperationReceipt } from './HostProtocol';

/** Private frontend transport. Closing it never cancels or stops host execution. */
export class HostClient {
  private readonly requests = new Set<http.ClientRequest>();
  private closed = false;
  constructor(private readonly address: HostAddress, private readonly credential: string, private readonly timeoutMs = 5000) {
    secret(credential);
    if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65535
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new HostError('invalid_address');
  }
  hello() { return this.call<{ capabilities: string[]; authorityId: string; acceptedThrough: number; retiredThrough: number; epoch: number; acknowledged: number; active: boolean; storageHealthy: boolean }>('hello', {}); }
  recoverFrontend(frontendId: string, epoch: number) { return this.call<FrontendLease>('recoverFrontend', { frontendId, epoch }); }
  inspect<T = Json>(lease: FrontendLease, operation: string, args: Json = null) { return this.call<T>('inspect', { lease, operation, args }); }
  submitSequenced(lease: FrontendLease, sequence: number, operation: string, args: Json) {
    return this.call<OperationReceipt>('submit', { lease, requestId: `sequenced-${sequence}`, requestSequence: sequence, operation, args });
  }
  prepare(lease: FrontendLease, successorId: string) { return this.call<{ ticket: string; expires: number }>('prepare', { lease, successorId }); }
  attach(frontendId: string, epoch: number, ticket?: string) {
    return this.call<{ attachment: string; expires: number }>('attach', { frontendId, epoch, ...(ticket !== undefined ? { ticket } : {}) });
  }
  activate(frontendId: string, epoch: number, attachment: string) { return this.call<FrontendLease>('activate', { frontendId, epoch, attachment }); }
  detach(lease: FrontendLease) { return this.call<{ detached: true }>('detach', { lease }); }
  submit(lease: FrontendLease, requestId: string, operation: string, args: Json) {
    return this.call<OperationReceipt>('submit', { lease, requestId, operation, args });
  }
  status(lease: FrontendLease, requestId: string) { return this.call<OperationReceipt>('status', { lease, requestId }); }
  events(lease: FrontendLease, after: number) { return this.call<{ acknowledged: number; through: number; events: HostEvent[] }>('events', { lease, after }); }
  /** ACK means the frontend's durable consumer accepted output, not native execution or Feishu delivery. */
  ack(lease: FrontendLease, through: number) { return this.call<{ acknowledged: number }>('ack', { lease, through }); }
  close(): void { this.closed = true; for (const request of this.requests) request.destroy(new HostError('client_closed')); }

  private call<T>(method: string, body: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new HostError('client_closed'));
    const data = JSON.stringify({ protocol: HOST_PROTOCOL, installationId: this.address.installationId, hostId: this.address.hostId, method, body });
    if (Buffer.byteLength(data) > MAX_REQUEST_BYTES) return Promise.reject(new HostError('request_too_large'));
    const nonce = randomBytes(32).toString('hex'); const timestamp = String(Date.now());
    return new Promise<T>((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: this.address.port, path: '/v1', method: 'POST', agent: false,
        headers: { 'x-session-host-nonce': nonce, 'x-session-host-time': timestamp,
          'x-session-host-signature': sign(this.credential, 'request', nonce, timestamp, data),
          'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, response => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) request.destroy(new HostError('invalid_response'));
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new HostError('transport_outcome_unknown')));
        response.on('end', () => {
          try {
            const data = Buffer.concat(chunks).toString('utf8');
            // An unsigned rejection is failure only, never an authority receipt.
            if (response.statusCode === 401) throw new HostError('unauthorized');
            if (!matchesSignature(response.headers['x-session-host-signature'], sign(this.credential, 'response', nonce, timestamp, data))) throw new HostError('unauthenticated_response');
            const reply: unknown = JSON.parse(data);
            if (!object(reply)) throw new HostError('invalid_response');
            if (reply.ok === false && typeof reply.code === 'string' && /^[a-z_]{1,80}$/.test(reply.code)) throw new HostError(reply.code);
            if (response.statusCode !== 200 || reply.ok !== true || reply.protocol !== HOST_PROTOCOL || reply.hostId !== this.address.hostId) throw new HostError('invalid_response');
            resolve(reply.value as T);
          } catch (error) { reject(error instanceof HostError ? error : new HostError('invalid_response')); }
        });
      });
      this.requests.add(request);
      const deadline = setTimeout(() => request.destroy(new HostError('transport_outcome_unknown')), this.timeoutMs);
      request.once('close', () => { clearTimeout(deadline); this.requests.delete(request); });
      request.once('error', error => reject(error instanceof HostError ? error : new HostError('transport_outcome_unknown')));
      request.end(data);
    });
  }
}
