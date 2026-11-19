import { promises as fs } from 'fs';
import path from 'path';

function contains(directory: string, file: string): boolean {
  const relative = path.posix.relative(directory, file);
  return !relative || (!path.posix.isAbsolute(relative) && relative !== '..' && !relative.startsWith('../'));
}

/** Auto-erasure needs positive local-volume evidence. Unknown filesystems retain the data. */
export async function exclusiveLocalVolume(root: string): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const inventory = await fs.readFile('/proc/self/mountinfo', 'utf8');
  return exclusiveLinuxMount(inventory, root);
}

export function exclusiveLinuxMount(inventory: string, root: string): boolean {
  if (!path.posix.isAbsolute(root)) return false;
  const mounts = inventory.trimEnd().split('\n').map(line => {
    const [fields, filesystem] = line.split(' - ');
    const [, , device, origin, name] = fields.split(' ');
    if (!device || !name || !filesystem) throw new Error('Incomplete mount inventory');
    const decode = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    const [type, source] = filesystem.split(' ');
    return { device, origin: decode(origin), name: decode(name), type, source };
  });
  const volume = mounts.filter(m => contains(m.name, root)).sort((a, b) => b.name.length - a.name.length)[0];
  if (!volume || volume.origin !== '/' || !volume.source?.startsWith('/dev/')
    || !['ext4', 'xfs', 'btrfs'].includes(volume.type)) return false;
  const physical = path.posix.join(volume.origin, path.posix.relative(volume.name, root));
  return !mounts.some(other => other !== volume && (other.name === volume.name || contains(root, other.name)
    || other.device === volume.device && (contains(other.origin, physical) || contains(physical, other.origin))));
}
