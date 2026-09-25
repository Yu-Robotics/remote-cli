/** Process-scoped Claude hooks; no global or project settings are modified. */
import net from 'net';

async function main(): Promise<void> {
  const [socketPath, token] = process.argv.slice(2);
  if (!socketPath || !token) throw new Error('Missing file policy connection.');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const event = JSON.parse(text);
  const startup = event.hook_event_name === 'SessionStart';
  if (!startup && event.hook_event_name !== 'PreToolUse') throw new Error('Unexpected hook event.');
  const input = event.tool_input ?? {};
  const payload = { type: 'file_policy', token, startup, tool_name: event.tool_name,
    input: { file_path: input.file_path, notebook_path: input.notebook_path } };
  const answer = await new Promise<any>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('File policy check timed out.')), 5000);
    let buffer = '';
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(new Error('File policy connection closed.')));
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { finish(undefined, JSON.parse(buffer.slice(0, newline))); }
      catch { finish(new Error('Invalid file policy response.')); }
    });
  });
  if (!['allow', 'ask', 'deny'].includes(answer?.decision)) throw new Error('Missing file policy decision.');
  if (startup) {
    if (answer.decision !== 'allow') throw new Error('File policy startup rejected.');
    return;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: answer.decision, permissionDecisionReason: answer.reason,
  } }) + '\n');
}

void main().catch(error => {
  // Exit 2 is a blocking hook failure, including connection and parse errors.
  process.stderr.write(`Remote CLI file policy unavailable: ${error.message}\n`);
  process.exitCode = 2;
});
