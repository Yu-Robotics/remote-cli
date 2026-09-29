import http from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import type { AddressInfo, Socket } from 'net';
import type { DelegationConnection, DelegationHandler } from './contract';
import { DELEGATION_TOOLS } from './contract';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One authenticated local endpoint per coordinator, active only during its turn. */
export class DelegationBridge {
  private server?: http.Server;
  private handler?: DelegationHandler;
  private connection?: DelegationConnection;
  private starting?: Promise<DelegationConnection>;
  private sockets = new Set<Socket>();

  activate(handler?: DelegationHandler): void { this.handler = handler; }

  async start(): Promise<DelegationConnection> {
    if (this.connection) return this.connection;
    if (this.starting) return this.starting;
    this.starting = this.listen();
    try { return await this.starting; } finally { this.starting = undefined; }
  }

  private async listen(): Promise<DelegationConnection> {
    const token = randomBytes(32).toString('hex');
    const server = http.createServer((request, response) => {
      const answer = (status: number, value: unknown) => {
        if (!response.destroyed) {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(value));
        }
      };
      const authorization = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
        answer(401, { error: 'Invalid delegation credential' }); request.resume(); return;
      }
      if (request.method !== 'POST' || request.url !== '/') {
        answer(404, { error: 'Unknown delegation endpoint' }); request.resume(); return;
      }
      const handler = this.handler;
      if (!handler) { answer(409, { error: 'No active delegation turn' }); request.resume(); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 128 * 1024) { answer(413, { error: 'Delegation request too large' }); request.destroy(); }
        else chunks.push(chunk);
      });
      request.on('error', () => { /* The caller may have been cancelled. */ });
      request.on('end', () => {
        if (size > 128 * 1024) return;
        let payload: unknown;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { answer(400, { error: 'Invalid JSON' }); return; }
        if (!isRecord(payload) || typeof payload.name !== 'string'
          || !DELEGATION_TOOLS.some(tool => tool.name === payload.name)
          || typeof payload.callId !== 'string' || payload.callId.length > 200
          || !isRecord(payload.args)) {
          answer(400, { error: 'Invalid delegation call' }); return;
        }
        if (this.handler !== handler) { answer(409, { error: 'Delegation turn expired' }); return; }
        void handler(payload.name, payload.args, payload.callId)
          .then(value => answer(200, value))
          .catch(error => answer(400, { error: error instanceof Error ? error.message : 'Delegation failed' }));
      });
    });
    server.requestTimeout = 35_000;
    server.headersTimeout = 10_000;
    server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    this.server = server;
    this.connection = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, token };
    return this.connection;
  }

  async close(): Promise<void> {
    this.handler = undefined;
    if (this.starting) await this.starting;
    const server = this.server;
    this.server = undefined;
    this.connection = undefined;
    if (!server) return;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
