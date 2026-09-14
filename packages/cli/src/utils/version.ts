export function isValidVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

export function isNewerVersion(remote: string, local: string): boolean {
  if (!isValidVersion(remote) || !isValidVersion(local)) return false;
  const parse = (version: string) => version.split('-', 1)[0].split('.').map(Number);
  const [remoteMajor, remoteMinor, remotePatch] = parse(remote);
  const [localMajor, localMinor, localPatch] = parse(local);
  if (remoteMajor !== localMajor) return remoteMajor > localMajor;
  if (remoteMinor !== localMinor) return remoteMinor > localMinor;
  return remotePatch > localPatch;
}
