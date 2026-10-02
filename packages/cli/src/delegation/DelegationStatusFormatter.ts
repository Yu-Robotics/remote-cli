import type { BackendAvailability } from './BackendRegistry';
import type { DelegationBackend } from './contract';
import { stripAnsi } from '../utils/stripAnsi';

const BACKEND_LABELS: Record<DelegationBackend, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  pi: 'Pi',
  agy: 'AGY CLI',
  opencode: 'OpenCode CLI',
  kimi: 'Kimi Code CLI',
  zcode: 'ZCode',
  dsh: 'DeepSeek Harness',
};

interface DelegationStatusOptions {
  enabled: boolean;
  coordinatorBackend: DelegationBackend;
  coordinatorSupported: boolean;
  backends: readonly BackendAvailability[];
}

interface StatusTag {
  color: 'green' | 'neutral' | 'red' | 'orange' | 'blue';
  label: string;
}

function backendLabel(backend: DelegationBackend): string {
  return BACKEND_LABELS[backend];
}

function tag({ color, label }: StatusTag): string {
  return `<text_tag color='${color}'>${label}</text_tag>`;
}

/** Keep executable output literal, short, and on one line inside Feishu rich text. */
function literal(text: string, limit: number): string {
  const characters = Array.from(stripAnsi(text).replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim());
  const shortened = characters.length > limit
    ? `${characters.slice(0, limit - 1).join('')}…` : characters.join('');
  return `<raw>${shortened.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</raw>`;
}

function availabilityTag(item: BackendAvailability, coordinatorBackend: DelegationBackend): StatusTag {
  if (item.backend === coordinatorBackend) return { color: 'blue', label: 'Coordinator' };
  if (!item.installed) return { color: 'red', label: 'Unavailable' };
  if (!item.worker) return { color: 'orange', label: 'Blocked' };
  return { color: 'green', label: 'Installed' };
}

function availabilityDetail(item: BackendAvailability): string {
  if (item.installed) return item.version || 'Version unavailable';
  return item.reason || 'Executable is unavailable';
}

/** Format the thread-scoped delegation menu as Feishu rich text. */
export function formatDelegationStatus({
  enabled,
  coordinatorBackend,
  coordinatorSupported,
  backends,
}: DelegationStatusOptions): string {
  const state = enabled
    ? { color: 'green' as const, label: 'Enabled' }
    : { color: 'neutral' as const, label: 'Off' };
  const coordinator = coordinatorSupported
    ? backendLabel(coordinatorBackend)
    : `${tag({ color: 'red', label: 'Unsupported' })} ${literal('This backend cannot register delegation tools.', 120)}`;
  const availability = backends.map(item => {
    const stateTag = availabilityTag(item, coordinatorBackend);
    return `- ${tag(stateTag)} **${backendLabel(item.backend)}** · ${literal(availabilityDetail(item), 180)}`;
  });
  const zcodeNote = coordinatorBackend === 'zcode'
    ? ['> ⚠️ **ZCode note:** Delegation temporarily replaces user-configured MCP servers. Native tools and plugins remain available; `/delegation off` restores the normal MCP configuration.']
    : [];

  return [
    '🤝 **Cross-backend delegation**',
    `${tag(state)} **Current thread**`,
    `**Coordinator:** ${coordinator}`,
    '',
    '**Backend availability**',
    ...availability,
    ...zcodeNote,
    '',
    '> **Worker rule:** Same-backend delegation is disabled. Use the current backend directly or its native subagents, if supported.',
    '> **When checked:** Authentication and quota are checked when a task starts.',
    '> **Sandbox:** Cross-backend delegation is unavailable while the coordinator sandbox is enabled.',
    '',
    '**Commands:** `/delegation on` · `/delegation off` · `/delegation reset [backend]`',
    'Applies to this thread. Worker sessions are isolated from direct conversations and continue across delegated tasks in the same workspace.',
  ].join('\n');
}
