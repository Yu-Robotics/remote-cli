import * as fs from 'fs';

/**
 * Check a backend working directory before a process or session uses it.
 * Node reports ENOENT for both a missing executable and a missing cwd, so
 * checking the directory first preserves the correct recovery guidance.
 */
export function assertWorkingDirectoryExists(workingDirectory?: string): void {
  if (!workingDirectory || fs.existsSync(workingDirectory)) return;
  throw new Error(
    `Working directory no longer exists: ${workingDirectory}. Use /cd <directory> to choose an existing working directory.`
  );
}
