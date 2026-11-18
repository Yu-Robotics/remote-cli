/** Only these fixed prefixes can be dispatched by a command card. */
interface Choice {
  id?: string;
  command: string;
  label: string;
  input?: string;
  confirm?: string;
}

const choice = (command: string, label: string, input?: string, confirm?: string): Choice =>
  ({ command, label, input, confirm });

const groups = {
  Workspace: [
    choice('/cd', 'Directories /cd'), choice('/files', 'Files /files'), choice('/thread list', 'Threads'),
    choice('/thread new', 'Create named thread', 'Thread name'), choice('/thread delete', 'Delete thread', 'Thread name'),
    choice('/files clear', 'Clear staged files', undefined, 'Remove unused local attachment copies?'),
    choice('/session', 'Session binding'), choice('/session detach', 'Detach session', undefined, 'Detach the native session?'),
    choice('/resume', 'Resume a Pi session'),
  ],
  Settings: [
    choice('/model', 'Model /model'), choice('/backend', 'Backend /backend'), choice('/effort', 'Reasoning effort'),
    choice('/sandbox', 'Sandbox status'), { ...choice('/sandbox', 'Configure sandbox', 'on, off, read-only, default, allow <path>, remove <path>, or network on/off'), id: 'configure_sandbox' },
    choice('/delegation', 'Delegation'), choice('/delegation reset', 'Reset worker context', 'Backend to reset'),
    { ...choice('/delegation reset', 'Reset all worker contexts', undefined, 'Reset all worker contexts in this thread?'), id: 'reset_all_workers' },
    choice('/skills', 'Installed backend skills'), choice('/slides', 'Slides (backend extension)', 'Slide request'),
  ],
  Conversation: [
    choice('/status', 'Status'), choice('/context', 'Context'), choice('/queue', 'Queue /queue'),
    choice('/queue continue', 'Continue queue', undefined, 'Resume the waiting queue?'),
    choice('/queue clear', 'Clear queue', undefined, 'Discard waiting messages?'),
    choice('/queue confirm', 'Confirm queued message', 'Queue ID'), choice('/queue cancel', 'Cancel queued message', 'Queue ID'),
    choice('/goal', 'Codex goal'), { ...choice('/goal', 'Set or update goal', 'Objective, pause, resume, or clear'), id: 'set_goal' },
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
    choice('/schedule cleanup confirm', 'Confirm reviewed cleanup', 'Review token, request ID, and reviewed native IDs'),
    choice('/schedule purge', 'Purge schedule history', 'Managed IDs separated by commas, or all'),
    choice('/schedule help', 'Schedule reference'),
  ],
  Devices: [
    choice('/device', 'My devices'), choice('/device switch', 'Switch device', 'Device ID or index'),
    choice('/device unbind', 'Unbind one device', 'Device ID or index'), choice('/bind', 'Bind device', 'Binding code'),
    choice('/unbind', 'Unbind all devices', undefined, 'Remove all your device bindings?'),
    choice('/help', 'Command reference'), choice('/tips', 'Tips and subscriptions'),
  ],
  Machines: [
    choice('/machines', 'Machines'), choice('/machine show', 'Machine details', 'Machine ID'),
    choice('/machine add', 'Add machine', 'Machine ID and user'), choice('/machine remove', 'Remove machine', 'Machine ID'),
    choice('/containers', 'Containers', 'Machine ID'), choice('/search', 'Search files', 'Machine ID, path and pattern'),
    choice('/view', 'View file', 'Machine ID and file path'), choice('/replace', 'Replace file', 'Machine ID and file path'),
    choice('/cancel', 'Cancel file replacement', undefined, 'Cancel the pending file replacement?'),
    choice('/backups', 'List backups', 'Machine ID and optional file path'), choice('/restore', 'Restore backup', 'Machine ID, backup path and target path'),
  ],
};

type Group = keyof typeof groups;
const shortcuts = ['/cd', '/model', '/backend', '/queue', '/files', '/schedule list'];
const all = Object.values(groups).flat();
const plain = (content: string) => ({ tag: 'plain_text', content });
export const commandMenuHeader = { template: 'blue', title: plain('Remote CLI commands') };

export class CommandMenu {
  private group?: Group;
  private selected?: Choice;
  private revision = 0;
  private busy = false;

  constructor(private readonly target: string) {}

  private choices(): Choice[] {
    return this.group ? groups[this.group] : shortcuts.map(command => all.find(item => item.command === command)!);
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
        const fields = [field('argument', input)];
        if (command === '/schedule cron') fields.push(field('timezone', 'IANA timezone (e.g. Asia/Shanghai)'));
        if (isScheduleCreation(command)) fields.push(field('prompt', 'Task to run'));
        elements.push({ tag: 'form', name: 'command_parameters', elements: [...fields, run] });
      } else elements.push(run);
      elements.push(this.button('Back', 'back'));
      return elements;
    }
    elements.push({ tag: 'markdown', content: '**' + (this.group || 'Quick access') + '**' });
    elements.push(...this.rows(this.choices().map(item => this.button(item.label, 'choose', item.id ?? item.command))));
    if (this.group) elements.push(this.button('All commands', 'back'));
    else {
      elements.push({ tag: 'markdown', content: '**Browse by group**' });
      elements.push(...this.rows(Object.keys(groups).map(group => this.button(group, 'group', group))));
    }
    return elements;
  }

  async click(action: { rev?: number; op?: string; value?: string }, form: unknown,
    update: (elements: any[]) => Promise<void>, execute: (command: string) => Promise<void>): Promise<string> {
    if (this.busy || action.rev !== this.revision) throw new Error('This menu has changed. Use its latest controls.');
    this.busy = true;
    const previous = { group: this.group, selected: this.selected };
    let command: string | undefined;
    try {
      if (action.op === 'back' && (this.selected || this.group)) {
        if (this.selected) this.selected = undefined;
        else this.group = undefined;
      } else if (action.op === 'group' && !this.selected && !this.group && Object.hasOwn(groups, action.value ?? '')) {
        this.group = action.value as Group;
      } else if (action.op === 'choose' && !this.selected) {
        const item = this.choices().find(entry => (entry.id ?? entry.command) === action.value);
        if (!item) throw new Error('Choose an available command.');
        if (item.input || item.confirm) this.selected = item;
        else command = item.command;
      } else if (action.op === 'run' && this.selected) {
        command = buildCommand(this.selected, form);
        this.selected = undefined;
      } else throw new Error('This command is unavailable.');
      this.revision++;
      try { await update(this.render()); }
      catch {
        this.group = previous.group;
        this.selected = previous.selected;
        this.revision--;
        throw new Error('Could not update the menu. Reopen /skills to retry.');
      }
      if (command) await execute(command);
      return command ? 'Request handled. See the command response.' : 'Menu updated.';
    } finally { this.busy = false; }
  }
}

function isScheduleCreation(command: string): boolean {
  return ['/schedule after', '/schedule at', '/schedule cron'].includes(command);
}

function buildCommand(item: Choice, form: unknown): string {
  if (!item.input) return item.command;
  const read = (key: string) => {
    const value = (form as Record<string, unknown> | null)?.[key];
    if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value) || value.length > 4096) {
      throw new Error('Complete each field with a single line of text.');
    }
    return value.trim();
  };
  const arg = read('argument');
  if (!isScheduleCreation(item.command)) return item.command.trim() + ' ' + arg;
  if (arg.includes(' -- ') || arg.includes('"')) throw new Error('Enter the time separately from the task.');
  const prompt = read('prompt');
  if (item.command !== '/schedule cron') return item.command + ' ' + arg + ' -- ' + prompt;
  const zone = read('timezone');
  if (/\s/.test(zone)) throw new Error('Enter a single IANA timezone.');
  return item.command + ' "' + arg + '" --tz ' + zone + ' -- ' + prompt;
}
