import { DELEGATION_TOOLS } from './contract';

/** Loaded explicitly by Pi; no project skill or global extension is installed. */
export default function registerDelegation(pi: any): void {
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
          const result = await response.json();
          if (!response.ok) throw new Error((result as any).error ?? 'Delegation failed');
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
      },
    });
  }
}
