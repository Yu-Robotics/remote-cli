import { DELEGATION_TOOLS } from './contract';

interface PiToolRegistration {
  name: string;
  label: string;
  description: string;
  parameters: (typeof DELEGATION_TOOLS)[number]['inputSchema'];
  execute: (callId: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

interface PiExtensionApi {
  registerTool(tool: PiToolRegistration): void;
}

function errorMessage(value: unknown): string {
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') {
    return value.error;
  }
  return 'Delegation failed';
}

/** Loaded explicitly by Pi; no project skill or global extension is installed. */
export default function registerDelegation(pi: PiExtensionApi): void {
  for (const tool of DELEGATION_TOOLS) {
    pi.registerTool({ name: tool.name, label: tool.name, description: tool.description,
      parameters: tool.inputSchema,
      async execute(callId: string, args: Record<string, unknown>, signal?: AbortSignal) {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) controller.abort();
        const timer = setTimeout(cancel, 32_000);
        try {
          const response = await fetch(process.env.REMOTE_CLI_DELEGATION_URL!, {
            method: 'POST', signal: controller.signal,
            headers: { authorization: `Bearer ${process.env.REMOTE_CLI_DELEGATION_TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify({ name: tool.name, args, callId }),
          });
          const result: unknown = await response.json();
          if (!response.ok) throw new Error(errorMessage(result));
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
      },
    });
  }
}
