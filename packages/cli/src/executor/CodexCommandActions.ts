import { sanitizeActivityText } from './Activity';

// Fit the existing compact heading so the Router cannot truncate the omission suffix.
const COMMAND_DESCRIPTION_LIMIT = 60;

const PROGRAM_LABELS: Record<string, string> = {
  git: 'Run Git command', npm: 'Run npm command', npx: 'Run npm command',
  pnpm: 'Run pnpm command', yarn: 'Run Yarn command', bun: 'Run Bun command',
  python: 'Run Python command', python3: 'Run Python command', node: 'Run Node.js command',
  pytest: 'Run tests', vitest: 'Run tests', tsc: 'Run TypeScript compiler',
  make: 'Run Make command', cmake: 'Run CMake command', cargo: 'Run Cargo command',
  go: 'Run Go command', docker: 'Run Docker command',
};

/** Use fixed labels only; never copy shell arguments, paths, or output into a heading. */
function describeShellCommand(command: unknown): string {
  if (typeof command !== 'string' || command.length > 4096 || /[;&|<>\r\n`$]/.test(command)) {
    return 'Run shell command';
  }
  const program = /^\s*([a-z0-9]+)(?:\s|$)/.exec(command)?.[1];
  return program && Object.hasOwn(PROGRAM_LABELS, program) ? PROGRAM_LABELS[program] : 'Run shell command';
}

/** Prefer native actions; unknown shell actions get an honest, bounded operation label. */
export function describeCodexCommandActions(value: unknown, command?: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return typeof command === 'string' ? describeShellCommand(command) : undefined;
  }
  const labels: string[] = [];
  for (const action of value) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return;
    let label: string;
    switch (action.type) {
      case 'read': {
        const file = [action.path, action.name].find(item => typeof item === 'string' && item.trim());
        const basename = typeof file === 'string'
          ? sanitizeActivityText(file.split(/[\\/]/).filter(Boolean).at(-1) ?? '')
          : '';
        label = basename && basename !== '.' && basename !== '..' ? `Read ${basename}` : 'Read file';
        break;
      }
      case 'search':
        label = 'Search files';
        break;
      case 'listFiles':
        label = 'List directory';
        break;
      case 'unknown':
        // Native app-server command actions carry command, not tool-call cmd.
        label = describeShellCommand(action.command);
        break;
      default:
        // Do not guess the meaning of malformed or future native action types.
        return;
    }
    if (!labels.includes(label)) labels.push(label);
  }
  const preview = labels.slice(0, 3);
  const suffix = labels.length > preview.length ? ` / +${labels.length - preview.length} more` : '';
  const labelLimit = Math.floor((COMMAND_DESCRIPTION_LIMIT - suffix.length - (preview.length - 1) * 3) / preview.length);
  return preview.map(label => {
    const characters = Array.from(label);
    return characters.length > labelLimit ? `${characters.slice(0, labelLimit - 1).join('')}…` : label;
  }).join(' / ') + suffix;
}
