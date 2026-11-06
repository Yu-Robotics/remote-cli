import type { OutputReference } from './Protocol';
import type { JobState, OutputJob } from './OutputTransfers';

type HeaderColor = 'blue' | 'green' | 'red' | 'orange' | 'grey';
type Action = { action: 'output_file'; id: string; op: 'get' }
  | { action: 'output_file'; id: string; op: 'retry'; rev: number };
interface PlainText { tag: 'plain_text'; content: string }
type Element = { tag: 'div'; text: PlainText }
  | { tag: 'markdown'; text_size: 'notation'; content: string }
  | { tag: 'button'; type: 'primary'; text: PlainText; behaviors: [{ type: 'callback'; value: Action }] };
interface Card {
  schema: '2.0';
  header: { title: PlainText; template: HeaderColor };
  body: { elements: Element[] };
}

const sources: Record<OutputReference['source'], string> = {
  workspace: 'Workspace file', worker: 'Worker output', export: 'Exported artifact',
};
const stages: Record<JobState, { title: string; color: HeaderColor; detail: string }> = {
  queued: { title: 'File transfer queued', color: 'blue', detail: 'Preparing to retrieve this file from the original device.' },
  'waiting-device': { title: 'Waiting for device', color: 'orange', detail: 'The transfer will continue when the original device reconnects.' },
  receiving: { title: 'Receiving file', color: 'blue', detail: 'Receiving the saved snapshot from the original device.' },
  'staged-verified': { title: 'File received', color: 'blue', detail: 'The snapshot is verified and ready to upload to Feishu.' },
  'upload-intent': { title: 'Uploading to Feishu', color: 'blue', detail: 'Uploading the file to Feishu.' },
  'file-key-saved': { title: 'Preparing file message', color: 'blue', detail: 'Upload complete. Preparing the file message for this chat.' },
  'send-intent': { title: 'Sending file message', color: 'blue', detail: 'Sending the native file message to this chat.' },
  delivered: { title: 'File delivered', color: 'green', detail: 'Find the file message in this chat.' },
  'send-uncertain': { title: 'Delivery unconfirmed', color: 'orange', detail: 'Feishu delivery could not be confirmed. The file will not be sent again automatically.' },
  failed: { title: 'File transfer failed', color: 'red', detail: 'The transfer did not complete. Use Retry below to try again.' },
  expired: { title: 'File expired', color: 'grey', detail: 'This file is no longer available. Ask for a new file link.' },
  revoked: { title: 'File unavailable', color: 'grey', detail: 'Original device ownership changed. Retrieval is no longer available.' },
};
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatOutputFileSize(value: number): string {
  const bytes = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KiB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB`;
}

/** Absolute UTC stays truthful even when a stable entry card is viewed much later. */
export function formatOutputExpiry(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown expiry (UTC)';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

const plain = (content: string): Element => ({ tag: 'div', text: { tag: 'plain_text', content } });
const note = (content: string): Element => ({ tag: 'markdown', text_size: 'notation', content });
function details(reference: OutputReference): Element[] {
  // Filenames are untrusted. Only controlled size/source/time text goes into Markdown.
  return [plain(reference.name), note(`${formatOutputFileSize(reference.size)} · ${sources[reference.source]}\nExpires ${formatOutputExpiry(reference.expiresAt)}`)];
}
function card(title: string, color: HeaderColor, elements: Element[], action?: Action): string {
  if (action) elements.push({ tag: 'button', type: 'primary',
    text: { tag: 'plain_text', content: action.op === 'get' ? 'Get file' : 'Retry' },
    behaviors: [{ type: 'callback', value: action }] });
  const result: Card = { schema: '2.0', header: { title: { tag: 'plain_text', content: title }, template: color }, body: { elements } };
  return JSON.stringify(result);
}

export function outputFileEntryCard(reference: OutputReference): string {
  const elements = details(reference);
  if (reference.discoveryIncomplete) elements.push(plain('Discovery limits were reached; this file list is not exhaustive.'));
  return card('File ready', 'blue', elements, { action: 'output_file', id: reference.id, op: 'get' });
}

/** The caller supplies time; rendering never changes expiry, state or retry admission. */
export function outputFileTransferCard(job: Pick<OutputJob, 'state' | 'received' | 'refId' | 'revision'>,
  reference: OutputReference, now: number): string {
  const stage = stages[job.state];
  const retry = job.state === 'failed' && reference.expiresAt > now;
  const elements = [...details(reference), plain(job.state === 'failed' && !retry
    ? 'The transfer failed and this file has expired. Ask for a new file link.' : stage.detail)];
  if (job.state === 'receiving') {
    const total = Number.isFinite(reference.size) ? Math.max(0, reference.size) : 0;
    const received = Math.min(total, Number.isFinite(job.received) ? Math.max(0, job.received) : 0);
    const percent = total > 0 ? Math.floor(received / total * 100) : 0;
    elements.push(plain(`${percent}% · ${formatOutputFileSize(received)} / ${formatOutputFileSize(total)} received`));
  }
  return card(stage.title, stage.color, elements, retry
    ? { action: 'output_file', id: job.refId, op: 'retry', rev: job.revision } : undefined);
}

export function outputFileDiscoveryCard(unavailable: number, omitted: boolean): string {
  const elements: Element[] = [];
  if (unavailable > 0) elements.push(plain(`${unavailable} linked ${unavailable === 1 ? 'file could' : 'files could'} not be exported.`));
  if (omitted) elements.push(plain('Discovery limits were reached; this file list is not exhaustive.'));
  elements.push(note('Only verified files have a Get file button.'));
  return card(unavailable > 0 ? 'Some files unavailable' : 'File discovery notice', 'orange', elements);
}
