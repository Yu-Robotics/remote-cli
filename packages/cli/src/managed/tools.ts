import { DELEGATION_TOOLS } from '../delegation/contract';
import { SCHEDULE_TOOLS } from '../scheduling/toolContract';
import type { ManagedToolConnection } from './contract';
export function managedTools(connection?: Pick<ManagedToolConnection, 'groups'>) {
  const groups = connection?.groups ?? ['delegation'];
  return [...(groups.includes('delegation') ? DELEGATION_TOOLS : []), ...(groups.includes('scheduling') ? SCHEDULE_TOOLS : [])];
}
export function environmentTools() {
  const raw = process.env.REMOTE_CLI_TOOL_GROUPS;
  if (!raw) return managedTools();
  try {
    const groups: unknown = JSON.parse(raw);
    if (Array.isArray(groups) && groups.every(group => group === 'delegation' || group === 'scheduling')) return managedTools({ groups });
  } catch { /* Invalid registrations expose no control tools. */ }
  return [];
}
