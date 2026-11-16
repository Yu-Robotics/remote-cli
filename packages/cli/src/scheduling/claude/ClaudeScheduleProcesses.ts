import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { processBirth } from '../../delegation/OwnershipRuntime';

export interface ScheduleHostIdentity { pid: number; birth?: string }
export interface ScheduleProcess extends ScheduleHostIdentity { command: string; argv?: string[] }

/** Read-only host inventory. This never certifies descendant/task completion. */
export function scheduleProcesses(): ScheduleProcess[] {
  if (process.platform === 'linux') {
    const names = fs.readdirSync('/proc');
    if (names.length > 100_000 || !names.includes(String(process.pid))) throw new Error('Native host inventory namespace is unavailable.');
    return names.filter(name => /^[1-9]\d*$/.test(name)).flatMap(name => {
      try {
        if (fs.statSync(`/proc/${name}`).uid !== process.getuid!()) return [];
        return [{ pid: Number(name), birth: processBirth(Number(name)),
          command: '', argv: fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean) }];
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
        throw new Error('Native host inventory is incomplete.');
      }
    });
  }
  if (process.platform === 'darwin') {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,lstart=,command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
    return output.trim().split('\n').map(line => {
      const match = line.match(/^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/);
      if (!match) throw new Error('Native host inventory is incomplete.');
      return { pid: Number(match[1]), birth: match[2], command: match[3] };
    });
  }
  if (process.platform === 'win32') {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,CreationDate,CommandLine,Name)'],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    const rows = JSON.parse(output);
    if (!Array.isArray(rows)) throw new Error('Native host inventory is incomplete.');
    return rows.map(row => ({ pid: row.ProcessId, birth: row.CreationDate,
      command: row.CommandLine ?? row.Name }));
  }
  throw new Error('Native host inventory is unsupported on this platform.');
}

/** Exclude live native hosts, not historical work. Legacy hosts without an
 * explicit session argument conflict conservatively until they actually exit. */
export function assertScheduleHostAvailable(processes: ScheduleProcess[], session: string, currentPid: number,
  command: string, saved?: ScheduleHostIdentity, legacyUnknown = true): ScheduleHostIdentity {
  const current = processes.find(item => item.pid === currentPid);
  if (!current || !Number.isSafeInteger(current.pid) || current.pid <= 1) throw new Error('Current native host identity is unavailable.');
  const basename = (value: string) => path.posix.basename(value.replace(/\\/g, '/'));
  const name = basename(command).replace(/\.exe$/i, '').toLowerCase();
  const wordsOf = (item: ScheduleProcess) => item.argv
    ?? item.command.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(word => word.replace(/^["']|["']$/g, '')) ?? [];
  const entrypoints = wordsOf(current).slice(0, 2).filter(word => !word.startsWith('-')
    && !/^(?:node|nodejs|bun|deno|python(?:\d+(?:\.\d+)?)?)(?:\.exe)?$/i.test(basename(word)));
  for (const item of processes) {
    if (item.pid === currentPid) continue;
    if (saved && item.pid === saved.pid && (!saved.birth || !item.birth || item.birth === saved.birth)) {
      throw new Error('The recorded native schedule host is still alive.');
    }
    const words = wordsOf(item);
    const stream = (flag: string) => words.includes(`${flag}=stream-json`)
      || words.indexOf(flag) >= 0 && words[words.indexOf(flag) + 1] === 'stream-json';
    const index = words.findIndex(word => word === '--resume' || word === '--session-id');
    const assigned = index >= 0 ? words[index + 1] : words.find(word => /^--(?:resume|session-id)=/.test(word))?.split('=')[1];
    const executable = words.slice(0, 2).some(word => basename(word).replace(/\.exe$/i, '').toLowerCase() === name
      || entrypoints.includes(word))
      || assigned === session && stream('--input-format') && stream('--output-format');
    if (!executable) continue;
    // A command with unreadable/missing arguments is uncertainty, not absence.
    if (assigned === session || !assigned && legacyUnknown) throw new Error('Another native host may own this schedule session.');
  }
  return { pid: current.pid, ...(current.birth && { birth: current.birth }) };
}
