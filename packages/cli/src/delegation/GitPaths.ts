import path from 'path';

/** Git uses forward slashes on Windows; normalize syntax without resolving links or folding case. */
export function nativeGitPath(value: string, paths: path.PlatformPath = path): string {
  return paths.sep === '\\' ? paths.normalize(value) : value;
}
