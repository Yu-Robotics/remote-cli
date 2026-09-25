/**
 * Standalone stdio MCP server that exposes Claude Code's permission-prompt tool.
 * Spawned by the claude process via --mcp-config; forwards each permission
 * request to the remote-cli executor over a local unix socket and returns the
 * user's decision. Usage: node approvalMcpServer.js <socketPath>
 *
 * Wire format (NDJSON over the unix socket):
 *   request:  { id, tool_name, input, tool_use_id }
 *   response: { id, behavior: 'allow' | 'deny', updatedInput?, message? }
 */
import * as net from 'net';
import * as crypto from 'crypto';

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write('approvalMcpServer: missing socket path argument\n');
  process.exit(1);
}

// Backstop timeout; the executor enforces its own shorter approval expiry.
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

function askExecutor(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const deny = (message: string) => finish({ id: payload.id, behavior: 'deny', message });

    const timer = setTimeout(() => deny('Approval request timed out'), REQUEST_TIMEOUT_MS);
    timer.unref?.();

    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        const answer = JSON.parse(line);
        if (answer && answer.id === payload.id) finish(answer);
      } catch {
        deny('Invalid approval response');
      }
    });
    socket.on('error', () => deny('Approval channel unavailable'));
    socket.on('close', () => deny('Approval channel closed'));
  });
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    void handleMessage(message);
  }
});

async function handleMessage(message: any): Promise<void> {
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'remote-cli-approval', version: '1.0.0' },
    });
    return;
  }
  if (message.method === 'tools/list') {
    reply(message.id, {
      tools: [{
        name: 'approval_prompt',
        description: 'Ask the remote user for permission to run a tool call.',
        inputSchema: {
          type: 'object',
          properties: {
            tool_name: { type: 'string' },
            input: { type: 'object' },
            tool_use_id: { type: 'string' },
          },
        },
      }],
    });
    return;
  }
  if (message.method === 'tools/call') {
    const args = message.params?.arguments ?? {};
    const answer = await askExecutor({
      id: crypto.randomUUID(),
      tool_name: args.tool_name,
      input: args.input,
      tool_use_id: args.tool_use_id,
    });
    reply(message.id, {
      content: [{ type: 'text', text: JSON.stringify({
        behavior: answer.behavior === 'allow' ? 'allow' : 'deny',
        ...(answer.behavior === 'allow' ? { updatedInput: answer.updatedInput ?? args.input } : {}),
        ...(answer.behavior === 'allow' && answer.updatedPermissions ? { updatedPermissions: answer.updatedPermissions } : {}),
        ...(answer.behavior !== 'allow' ? { message: answer.message ?? 'Denied by remote user' } : {}),
      }) }],
    });
    return;
  }
  if (message.id !== undefined) reply(message.id, {});
}

function reply(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
