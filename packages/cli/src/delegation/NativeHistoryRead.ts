import path from 'path';
import { nativeBindings, type NativeHandle } from '../native/NativeBindings';

/** Read exports through held directory handles, including each ancestor of the root. */
export function readNativeHistoryTree(root: string, anchors: readonly { path: string; dev: string; ino: string }[],
  maxBytes: number, maxEntries: number): Map<string, Buffer> {
  const native = nativeBindings(), handles: NativeHandle[] = [];
  const result = new Map<string, Buffer>();
  let total = 0, count = 0, entered = false;
  const verify = (handle: NativeHandle, location: string) => {
    const expected = anchors.find(value => value.path === location);
    const stat = native.stat(handle);
    if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) throw new Error('Native export ancestor changed');
    if (process.getuid && stat.uid !== String(process.getuid())) throw new Error('Native export owner changed');
  };
  try {
    const volume = path.parse(root).root;
    let parent = native.openRoot(volume), current = volume;
    handles.push(parent);
    for (const component of root.slice(volume.length).split(path.sep).filter(Boolean)) {
      parent = native.openChild(parent, component, true); handles.push(parent);
      current = path.join(current, component);
      // Shared volume ancestors need not be owned by this user; recorded roots must match.
      const expected = anchors.find(value => value.path === current);
      if (expected) verify(parent, current);
    }
    const visit = (directory: NativeHandle, prefix: string, depth: number): void => {
      if (depth > 64 || ++count > maxEntries) throw new Error('Native export nesting exceeds the limit');
      for (const name of native.entries(directory).sort()) {
        const child = native.openEntry(directory, name);
        try {
          const stat = native.stat(child);
          if (stat.kind === 'directory') visit(child, prefix + name + '/', depth + 1);
          else {
            if (stat.kind !== 'file' || stat.nlink !== '1' || result.size >= maxEntries) throw new Error('Unsupported native export file');
            const bytes = native.read(child, maxBytes - total);
            total += bytes.length; result.set(prefix + name, bytes);
          }
        } finally { native.close(child); }
      }
    };
    entered = true;
    visit(parent, '', 0);
    return result;
  } catch (error) {
    if (entered || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return result;
  } finally { for (const handle of handles.reverse()) native.close(handle); }
}
