/** Process-local tool registration. Omitted groups retain the legacy delegation contract. */
export interface ManagedToolConnection {
  url: string;
  token: string;
  groups?: readonly ('delegation' | 'scheduling')[];
}
export type ManagedToolHandler = (name: string, args: Record<string, unknown>, callId: string) => Promise<unknown>;
export function hasDelegationTools(connection?: ManagedToolConnection): boolean {
  return !!connection && (!connection.groups || connection.groups.includes('delegation'));
}
