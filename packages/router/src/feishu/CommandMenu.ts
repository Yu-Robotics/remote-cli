import { buildMachineCommand, machineFormElement, type MachineField } from './MachineCommandForm';

/** Only these fixed prefixes can be dispatched by a command card. */
interface Choice {
  id?: string;
  command: string;
  label: string;
  input?: string | readonly MachineField[];
  confirm?: string;
}

const choice = (command: string, label: string, input?: Choice['input'], confirm?: string): Choice =>
  ({ command, label, input, confirm });

const groups = {
  Workspace: [
    choice('/cd', 'Directories /cd'), choice('/files', 'Files /files'), choice('/thread list', 'Threads'),
    choice('/thread new', 'Create named thread', 'Thread name'), choice('/thread delete', 'Delete thread', 'Thread name'),
    choice('/files clear', 'Clear staged files', undefined, 'Remove unused local attachment copies?'),
    choice('/session', 'Session binding'), choice('/session detach', 'Detach session', undefined, 'Detach the native session?'),
    choice('/session confirm', 'Confirm detach', 'Confirmation token'), choice('/session cancel', 'Cancel detach', 'Confirmation token'),
    choice('/resume', 'List saved sessions'),
    ...['claude', 'codex', 'pi'].map(backend => choice('/resume backend ' + backend, 'Browse ' + backend + ' sessions')),
    choice('/resume id', 'Select by session ID', 'Native session ID'),
    choice('/resume page', 'Go to page', 'Menu token'), choice('/resume search', 'Find sessions', 'Menu token'),
    choice('/resume select', 'Select a row', 'Menu token'), choice('/resume confirm', 'Confirm connection', 'Confirmation token'),
    choice('/resume cancel', 'Cancel connection', 'Confirmation token'),
  ],
  Settings: [
    choice('/model', 'Model /model'), choice('/backend', 'Backend /backend'), choice('/effort', 'Reasoning effort'),
    choice('/sandbox', 'Sandbox status'), choice('/sandbox on', 'Enable sandbox', undefined, 'Enable the sandbox for this thread?'),
    choice('/sandbox off', 'Disable sandbox', undefined, 'Disable the sandbox for this thread?'),
    choice('/sandbox read-only', 'Read-only mode', undefined, 'Use read-only mode for this thread?'),
    choice('/sandbox default', 'Restore default', undefined, 'Restore the default sandbox settings?'),
    choice('/sandbox allow', 'Allow directory', 'Directory path'), choice('/sandbox remove', 'Remove directory', 'Directory path'),
    choice('/sandbox network on', 'Enable network', undefined, 'Allow network access in this sandbox?'),
    choice('/sandbox network off', 'Disable network', undefined, 'Disable network access in this sandbox?'),
    choice('/delegation', 'Open worker settings'), choice('/delegation on', 'Enable delegation', undefined, 'Enable delegation in this thread?'),
    choice('/delegation off', 'Disable delegation', undefined, 'Disable delegation in this thread?'),
    ...['claude', 'codex', 'agy', 'opencode', 'kimi', 'zcode', 'pi', 'dsh'].map(backend =>
      choice('/delegation reset ' + backend, 'Reset ' + backend, undefined, 'Reset the ' + backend + ' worker context in this thread?')),
    { ...choice('/delegation reset', 'Reset all worker contexts', undefined, 'Reset all worker contexts in this thread?'), id: 'reset_all_workers' },
    choice('/skills', 'Installed backend skills'), choice('/slides', 'Slides (backend extension)', 'Slide request'),
  ],
  Conversation: [
    choice('/status', 'Status'), choice('/context', 'Context'), choice('/queue', 'Queue /queue'),
    choice('/queue continue', 'Continue queue', undefined, 'Resume the waiting queue?'),
    choice('/queue clear', 'Clear queue', undefined, 'Discard waiting messages?'),
    choice('/queue confirm', 'Confirm queued message', 'Pending confirmation ID'), choice('/queue cancel', 'Cancel queued message', 'Pending confirmation ID'),
    choice('/goal status', 'Current goal'), { ...choice('/goal', 'Start goal', 'Objective (optionally preceded by --budget <tokens>)'), id: 'set_goal' },
    choice('/goal pause', 'Pause goal', undefined, 'Pause the current goal?'),
    choice('/goal resume', 'Resume goal', undefined, 'Resume the current goal?'),
    { ...choice('/goal resume --budget', 'Resume with budget', 'Token budget'), id: 'resume_budget' },
    choice('/goal clear', 'Clear goal', undefined, 'Remove the current goal?'),
    choice('/compact', 'Compact conversation', undefined, 'Compact the current conversation?'),
    choice('/abort', 'Abort current turn', undefined, 'Interrupt the running turn in this thread?'),
    choice('/clear', 'Clear conversation (/new)', undefined, 'Clear this thread, its worker contexts, and its local schedules?'),
  ],
  Schedules: [
    choice('/schedule list', 'Scheduled tasks'), choice('/schedule after', 'Run after a delay', 'Delay (e.g. 15m)'),
    choice('/schedule at', 'Run at a time', 'ISO timestamp with UTC offset'),
    choice('/schedule cron', 'Recurring task', 'Five cron fields (e.g. 0 9 * * 1-5)'),
    choice('/schedule cancel', 'Cancel schedule', 'Schedule ID'), choice('/schedule capabilities', 'Capabilities'),
    choice('/schedule cleanup review', 'Review legacy schedules'),
    choice('/schedule cleanup confirm', 'Confirm reviewed cleanup', 'Review token'),
    choice('/schedule purge', 'Purge schedule history', 'Managed IDs separated by commas, or all'),
    choice('/schedule help', 'Schedule reference'),
  ],
  Devices: [
    choice('/device list', 'My devices'), choice('/device switch', 'Switch device', 'Device ID or index'),
    choice('/device unbind', 'Unbind one device', 'Device ID or index'), choice('/bind', 'Bind device', 'Binding code'),
    choice('/unbind', 'Unbind all devices', undefined, 'Remove all your device bindings?'),
  ],
  'Help and tips': [
    choice('/help', 'Command reference'), choice('/tips next', 'Read next tip'), choice('/tips list', 'Browse topics'),
    choice('/tips settings', 'Subscription settings'), choice('/tips daily', 'Daily tips', undefined, 'Receive tips daily?'),
    choice('/tips weekly', 'Weekly tips', undefined, 'Use the weekly tip schedule?'),
    choice('/tips mute', 'Pause tips', 'Number of days (1 to 365)'), choice('/tips unmute', 'End pause', undefined, 'Resume tip delivery?'),
    choice('/tips timezone', 'Set timezone', 'IANA timezone (e.g. Asia/Shanghai)'),
    choice('/tips off', 'Stop tips', undefined, 'Stop automatic tip delivery?'),
  ],
  Machines: [
    choice('/machines', 'Machines'), choice('/machine show', 'Machine details', ['machine']),
    choice('/machine add', 'Add machine', ['machine', 'user', 'ssh_port']), choice('/machine remove', 'Remove machine', ['machine']),
    choice('/containers', 'Containers', ['machine']), choice('/search', 'Search files', ['machine', 'search_path', 'pattern', 'target', 'container']),
    choice('/view', 'View file', ['machine', 'file', 'target', 'container', 'lines']),
    choice('/replace', 'Replace file', ['machine', 'file', 'target', 'container']),
    choice('/cancel', 'Cancel file replacement', undefined, 'Cancel the pending file replacement?'),
    choice('/backups', 'List backups', ['machine', 'filter_path']),
    choice('/restore', 'Restore backup', ['machine', 'backup', 'destination', 'target', 'container']),
  ],
};

type Group = keyof typeof groups;
const familyLabels: Record<string, string> = {
  '/device': 'Your devices', '/files': 'Staged files', '/thread': 'Threads', '/session': 'Session binding',
  '/resume': 'Saved sessions', '/delegation': 'Delegated workers', '/queue': 'Message queue', '/goal': 'Codex goals',
  '/sandbox': 'Sandbox settings', '/schedule': 'Scheduled tasks', '/tips': 'Illustrated tips', '/machine': 'Manage machines',
  '/delegation reset': 'Reset worker context', '/schedule cleanup': 'Legacy cleanup',
  '/sandbox network': 'Network access', '/resume backend': 'Browse by backend',
};
const shortcuts = ['/cd', '/model', '/backend', '/queue', '/files', '/schedule'];
const all = Object.values(groups).flat();
interface Page { title: string; choices: Choice[]; prefix: string }
type MenuEntry = { key: string; label: string } & ({ page: Page } | { choice: Choice });

/** Group only whole command words, keeping bare commands available inside their own menu. */
function entries(page: Page): MenuEntry[] {
  const result: MenuEntry[] = [];
  const seen = new Set<string>();
  for (const item of page.choices) {
    const suffix = item.command.slice(page.prefix.length).trim();
    const word = suffix.split(' ')[0];
    if (word) {
      if (seen.has(word)) continue;
      seen.add(word);
      const prefix = [page.prefix, word].filter(Boolean).join(' ');
      const children = page.choices.filter(other => other.command === prefix || other.command.startsWith(prefix + ' '));
      if (children.length > 1 || suffix !== word) {
        const label = familyLabels[prefix] ?? word;
        result.push({ key: prefix, label: label + ' ›', page: { title: prefix, choices: children, prefix } });
        continue;
      }
    }
    result.push({ key: item.id ?? item.command, label: page.prefix && word ? word + ' · ' + item.label : item.label, choice: item });
  }
  return result;
}
const rootEntries = entries({ title: '', choices: all, prefix: '' });
const repeatableViews = new Set(['/schedule list', '/files', '/queue', '/device list', '/machines', '/status', '/context']);
const plain = (content: string) => ({ tag: 'plain_text', content });
export const commandMenuHeader = { template: 'blue', title: plain('Remote CLI commands') };

export class CommandMenu {
  private path: Page[] = [];
  private selected?: Choice;
  private revision = 0;
  private pendingView: Promise<void> = Promise.resolve();
  private readonly pendingReads = new Set<string>();

  constructor(private readonly target: string, private readonly devices: ReadonlyArray<{ deviceId: string; deviceName: string }> = []) {}

  private entries(): MenuEntry[] {
    const page = this.path.at(-1);
    return page ? entries(page) : shortcuts.map(key => rootEntries.find(entry => entry.key === key)!);
  }

  private button(label: string, op: string, value?: string, submit = false) {
    return { tag: 'button', text: plain(label), type: submit ? 'primary' : 'default',
      ...(submit && this.selected?.input ? { name: 'submit', form_action_type: 'submit' } : {}),
      behaviors: [{ type: 'callback', value: { action: 'command_menu', rev: this.revision, op, value } }] };
  }

  private rows(buttons: ReturnType<CommandMenu['button']>[]) {
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) {
      rows.push({ tag: 'column_set', flex_mode: 'bisect', columns: buttons.slice(i, i + 2).map(button =>
        ({ tag: 'column', width: 'weighted', weight: 1, elements: [button] })) });
    }
    return rows;
  }

  render(): any[] {
    const elements: any[] = [{ tag: 'div', text: plain(this.target) }];
    if (this.selected) {
      const { label, command, confirm, input } = this.selected;
      elements.push({ tag: 'div', text: plain(label + '  ' + command.trim()) });
      if (confirm) elements.push({ tag: 'div', text: plain(confirm) });
      const run = this.button(input ? 'Submit' : 'Confirm', 'run', undefined, true);
      if (input) {
        const field = (name: string, hint: string) => ({ tag: 'input', name, label: plain(hint), placeholder: plain(hint), required: true });
        const fields: any[] = typeof input === 'string' ? [field('argument', input)] : input.map(machineFormElement);
        if (isDevicePicker(command)) {
          fields[0] = { tag: 'select_static', name: 'argument', required: true, placeholder: plain('Choose a device'),
            options: this.devices.map((device, index) => ({ text: plain(device.deviceName.slice(0, 60) + ' (' + (index + 1) + ')'), value: String(index) })) };
        }
        const sessionField = sessionMenuFields[command];
        if (sessionField) fields.push(field('selection', sessionField));
        if (command === '/schedule cleanup confirm') {
          fields.push(field('request_id', 'Request ID'), field('native_ids', 'Reviewed native IDs, separated by commas'));
        }
        if (command === '/schedule cron') fields.push(field('timezone', 'IANA timezone (e.g. Asia/Shanghai)'));
        if (isScheduleCreation(command)) fields.push(field('prompt', 'Task to run'));
        elements.push({ tag: 'form', name: 'command_parameters', elements: [...fields, run] });
      } else elements.push(run);
      elements.push(this.button('Back', 'back'));
      return elements;
    }
    elements.push({ tag: 'markdown', content: '**' + (this.path.map(page => page.title).join(' › ') || 'Quick access') + '**' });
    elements.push(...this.rows(this.entries().map(item => this.button(item.label, 'choose', item.key))));
    if (this.path.length) elements.push(this.button('Back', 'back'));
    else {
      elements.push({ tag: 'markdown', content: '**Browse by group**' });
      elements.push(...this.rows(Object.keys(groups).map(group => this.button(group, 'group', group))));
    }
    return elements;
  }

  async click(action: { rev?: number; op?: string; value?: string }, form: unknown,
    update: (elements: any[]) => Promise<void>, execute: (command: string) => Promise<void>): Promise<string> {
    // Serialize card patches, including a click received while Feishu is acknowledging the previous patch.
    const change = this.pendingView.then(async () => {
      if (!Number.isSafeInteger(action.rev) || action.rev! < 0 || action.rev! > this.revision) throw new Error('Invalid menu control.');
      if (action.rev !== this.revision) {
        await update(this.render());
        return { notice: 'Menu refreshed. Use the buttons now shown.' };
      }
      const previous = { path: this.path, selected: this.selected };
      let command: string | undefined;
      if (action.op === 'back' && (this.selected || this.path.length)) {
        if (this.selected) this.selected = undefined;
        else this.path = this.path.slice(0, -1);
      } else if (action.op === 'group' && !this.selected && !this.path.length && Object.hasOwn(groups, action.value ?? '')) {
        const group = action.value as Group;
        const page = { title: group, choices: groups[group], prefix: '' };
        const options = entries(page);
        this.path = [options.length === 1 && 'page' in options[0] ? options[0].page : page];
      } else if (action.op === 'choose' && !this.selected) {
        const item = this.entries().find(entry => entry.key === action.value);
        if (!item) throw new Error('Choose an available command.');
        if ('page' in item) this.path = [...this.path, item.page];
        else {
          if (isDevicePicker(item.choice.command) && !this.devices.length) throw new Error('No devices to select. Bind a device and reopen /skills.');
          if (item.choice.input || item.choice.confirm) this.selected = item.choice;
          else command = item.choice.command;
        }
      } else if (action.op === 'run' && this.selected) {
        if (isDevicePicker(this.selected.command)) {
          const selected = (form as { argument?: unknown } | null)?.argument;
          const device = typeof selected === 'string' && /^(0|[1-9]\d*)$/.test(selected) ? this.devices[Number(selected)] : undefined;
          if (!device || /\s/.test(device.deviceId)) throw new Error('Select a device from this menu.');
          command = this.selected.command + ' ' + device.deviceId;
        } else command = buildCommand(this.selected, form);
        this.selected = undefined;
      } else throw new Error('This command is unavailable.');
      if (action.op === 'choose' && command && repeatableViews.has(command)) {
        if (this.pendingReads.has(command)) return { notice: 'This view is already opening.' };
        this.pendingReads.add(command);
        return { command, read: true };
      }
      this.revision++;
      try { await update(this.render()); }
      catch {
        this.path = previous.path;
        this.selected = previous.selected;
        this.revision--;
        throw new Error('Could not update the menu. Reopen /skills to retry.');
      }
      return { command };
    });
    this.pendingView = change.then(() => {}, () => {});
    const result = await change;
    if (result.notice) return result.notice;
    if (!result.command) return 'Menu updated.';
    try { await execute(result.command); }
    finally { if (result.read) this.pendingReads.delete(result.command); }
    return 'Request handled. See the command response.';
  }
}

function isDevicePicker(command: string): boolean {
  return command === '/device switch' || command === '/device unbind';
}

function isScheduleCreation(command: string): boolean {
  return ['/schedule after', '/schedule at', '/schedule cron'].includes(command);
}

const sessionMenuFields: Record<string, string> = {
  '/resume page': 'Page number', '/resume search': 'Search text', '/resume select': 'Row number',
};

function buildCommand(item: Choice, form: unknown): string {
  if (!item.input) return item.command;
  if (typeof item.input !== 'string') return buildMachineCommand(item.command, item.input, form);
  const read = (key: string) => {
    const value = (form as Record<string, unknown> | null)?.[key];
    if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value) || value.length > 4096) {
      throw new Error('Complete each field with a single line of text.');
    }
    return value.trim();
  };
  const arg = read('argument');
  if (sessionMenuFields[item.command]) {
    if (/\s/.test(arg)) throw new Error('Enter the menu token separately.');
    return item.command + ' ' + arg + ' ' + read('selection');
  }
  if (item.command === '/schedule cleanup confirm') {
    const args = [arg, read('request_id'), read('native_ids')];
    if (args.some(value => /\s/.test(value))) throw new Error('Use one token per field and separate native IDs with commas.');
    return [item.command, ...args].join(' ');
  }
  if (item.id === 'set_goal' && /^(?:status|help|pause|clear|resume)(?:\s|$)/.test(arg)) {
    throw new Error('Enter a goal objective or select a goal subcommand.');
  }
  if (!isScheduleCreation(item.command)) return item.command.trim() + ' ' + arg;
  if (arg.includes(' -- ') || arg.includes('"')) throw new Error('Enter the time separately from the task.');
  const prompt = read('prompt');
  if (item.command !== '/schedule cron') return item.command + ' ' + arg + ' -- ' + prompt;
  const zone = read('timezone');
  if (/\s/.test(zone)) throw new Error('Enter a single IANA timezone.');
  return item.command + ' "' + arg + '" --tz ' + zone + ' -- ' + prompt;
}
