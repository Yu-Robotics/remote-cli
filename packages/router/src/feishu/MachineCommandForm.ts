interface Field {
  label: string;
  optional?: boolean;
  pattern?: RegExp;
  max?: number;
  flag?: string;
}

const id = /^[A-Za-z0-9_.-]+$/;
const path = /^[A-Za-z0-9_./~-]+$/;
const fields = {
  machine: { label: 'Machine ID', pattern: id },
  user: { label: 'SSH user' },
  ssh_port: { label: 'SSH port (optional, default 22)', optional: true, max: 65535, flag: '--port' },
  search_path: { label: 'Search directory', pattern: path },
  pattern: { label: 'Filename pattern' },
  file: { label: 'File path', pattern: path },
  filter_path: { label: 'Filter by file path (optional)', optional: true, pattern: path },
  backup: { label: 'Backup path', pattern: path },
  destination: { label: 'Restore to path', pattern: path },
  target: { label: 'Target', optional: true },
  container: { label: 'Container ID (optional, default welding)', optional: true, pattern: id, flag: '--container' },
  lines: { label: 'Lines (optional, 1-500)', optional: true, max: 500, flag: '--lines' },
} satisfies Record<string, Field>;

export type MachineField = keyof typeof fields;
const plain = (content: string) => ({ tag: 'plain_text', content });

export function machineFormElement(name: MachineField) {
  const field: Field = fields[name];
  if (name === 'target') {
    return { tag: 'select_static', name, placeholder: plain(field.label), initial_option: 'container',
      options: [{ text: plain('Container'), value: 'container' }, { text: plain('Host'), value: 'host' }] };
  }
  return { tag: 'input', name, label: plain(field.label), placeholder: plain(field.label), required: !field.optional };
}

/** The CLI tokenizes using whitespace. Only this schema can introduce switches. */
export function buildMachineCommand(command: string, names: readonly MachineField[], form: unknown): string {
  const values = (form ?? {}) as Record<string, unknown>;
  const args = [command];
  for (const name of names) {
    const field: Field = fields[name];
    const raw = values[name];
    if (field.optional && (raw === undefined || raw === null || raw === '')) continue;
    if (typeof raw !== 'string' || raw.length > 4096 || /[\r\n\0]/.test(raw)) throw new Error('Invalid ' + field.label + '.');
    const value = raw.trim();
    if (!value && field.optional) continue;
    if (!value || /\s/.test(value) || value.startsWith('-') || field.pattern && !field.pattern.test(value)) {
      throw new Error('Enter a valid single value for ' + field.label + '.');
    }
    if (field.max && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > field.max)) {
      throw new Error('Enter a whole number from 1 to ' + field.max + '.');
    }
    if (name === 'target') {
      if (value === 'host') args.push('--host');
      else if (value !== 'container') throw new Error('Select Host or Container.');
    } else {
      if (name === 'container' && args.includes('--host')) throw new Error('Choose Container to specify a container ID.');
      if (field.flag) args.push(field.flag);
      args.push(value);
    }
  }
  return args.join(' ');
}
