import path from 'path';

/** Keep ordinary session persistence untouched. Only the schedule domain uses fresh process-owned storage. */
export function sessionSchedulePatch(directory: string, scope: string): string {
  const services = ['connection:dsh-client-connection', 'file-upload:dsh-client-file-upload',
    'workspace:dsh-workspace', 'session-controller:dsh-api-session-controller'];
  return [
    { id: 'storage-domain', config: { backend: 'json', routes: { schedule: 'remoteCliSessionSchedule' } } },
    { id: 'acp', inject: ['acpAppStartup', 'remoteCliSessionScheduleReady'] },
    { insert: [
      ...services.map(service => { const [id, name] = service.split(':'); return { id, name: `@deepseek-ai/${name}` }; }),
      { id: 'remote-cli-session-schedule-storage', name: path.join(__dirname, 'SessionScheduleStorage.js'), config: { directory } },
      { id: 'remote-cli-session-schedule-bridge', name: path.join(__dirname, 'SessionScheduleBridge.js'), config: { scope } },
    ] },
  ].map(row => `- ${JSON.stringify(row)}\n`).join('');
}
