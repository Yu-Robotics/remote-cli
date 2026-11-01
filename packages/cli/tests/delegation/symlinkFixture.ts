import fs from 'fs';
import os from 'os';
import path from 'path';

/** Probe the exact capability: Windows file symlinks need Developer Mode or elevation. */
function fileSymlinkCapability(): boolean {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-file-symlink-')));
  try {
    fs.writeFileSync(path.join(directory, 'target'), 'synthetic link target');
    fs.symlinkSync('target', path.join(directory, 'link'), 'file');
    return fs.lstatSync(path.join(directory, 'link')).isSymbolicLink();
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

export const supportsFileSymlinks = fileSymlinkCapability();
