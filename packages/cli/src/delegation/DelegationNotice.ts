import type { DelegatedTaskRecord } from './DelegationStore';
import type { DelegationBackend } from './contract';
import { stripAnsi } from '../utils/stripAnsi';

const BACKEND_LABELS: Record<DelegationBackend, string> = {
  claude: 'Claude Code', codex: 'Codex', pi: 'Pi', agy: 'AGY',
  opencode: 'OpenCode', kimi: 'Kimi Code', zcode: 'ZCode', dsh: 'DSH',
};

const TERMINAL_STYLES = {
  succeeded: { color: 'green', label: 'Completed', icon: '✅' },
  failed: { color: 'red', label: 'Failed', icon: '❌' },
  timed_out: { color: 'orange', label: 'Timed out', icon: '⏱️' },
  cancelled: { color: 'neutral', label: 'Cancelled', icon: '⏹️' },
  interrupted: { color: 'orange', label: 'Interrupted', icon: '⚠️' },
};

/** Keep backend text literal, short, and on one line inside Feishu rich text. */
function literal(text: string, limit: number): string {
  const characters = Array.from(stripAnsi(text).replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim());
  const shortened = characters.length > limit
    ? `${characters.slice(0, limit - 1).join('')}…` : characters.join('');
  return `<raw>${shortened.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</raw>`;
}

function elapsed(record: DelegatedTaskRecord): string {
  const seconds = Math.max(0, Math.floor(((record.finishedAt ?? record.startedAt) - record.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`;
}

/** Uses the existing text stream so older Routers can render the same result block. */
export function formatDelegationNotice(record: DelegatedTaskRecord): string {
  const style = TERMINAL_STYLES[record.state as keyof typeof TERMINAL_STYLES]
    ?? { color: 'neutral', label: 'Ended', icon: 'ℹ️' };
  const backend = BACKEND_LABELS[record.backend as DelegationBackend] ?? 'Agent';
  const lines = [
    `<text_tag color='${style.color}'>${style.icon} ${style.label}</text_tag> **${backend} · Delegated task**`,
    `> **Task:** ${literal(record.objective, 160)}`,
    `> **Elapsed:** ${elapsed(record)}`,
  ];
  if (record.state !== 'succeeded') {
    const reason = record.error?.trim() || 'No error details were returned by the backend.';
    lines.push(`> **Reason:** ${literal(reason, 400)}`);
  }
  return `\n\n${lines.join('\n')}\n\n`;
}
