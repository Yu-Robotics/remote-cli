import fs from 'fs';
import path from 'path';

export interface FilePolicyDecision {
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
}

// Include native protected paths plus remote-cli authorization and credential
// files. Check both the requested spelling and the resolved destination.
// https://code.claude.com/docs/en/permission-modes#protected-paths
const protectedNames = new Set([
  '.git', '.remote-cli', '.codex', '.ssh', '.vscode', '.idea', '.husky',
  '.cargo', '.devcontainer', '.yarn', '.mvn', '.mcp.json', '.claude.json',
  '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.bash_login',
  '.bash_aliases', '.bash_logout', '.zshrc', '.zprofile', '.zshenv', '.zlogin',
  '.zlogout', '.profile', '.envrc', '.npmrc', '.yarnrc', '.yarnrc.yml',
  '.pnp.cjs', '.pnp.loader.mjs', '.pnpmfile.cjs', 'bunfig.toml', '.bunfig.toml',
  '.bazelrc', '.bazelversion', '.bazeliskrc', '.pre-commit-config.yaml',
  'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml',
  'gradle-wrapper.properties', 'maven-wrapper.properties', '.devcontainer.json',
  '.ripgreprc', 'pyrightconfig.json', '.env',
]);

function isProtected(target: string): boolean {
  const parts = target.toLowerCase().split(path.sep);
  return parts.some((name, index) => {
    // Native worktrees remain editable; their own .git/.claude files do not.
    if (name === '.claude') return parts[index + 1] !== 'worktrees';
    return protectedNames.has(name) || name.startsWith('.env.')
      || (name === 'git' && parts[index - 1] === '.config');
  });
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Native deny/ask rules are still evaluated after this PreToolUse decision. */
export function evaluateFileWrite(tool: string, input: Record<string, unknown>, roots: string[]): FilePolicyDecision {
  const ask = (reason: string): FilePolicyDecision => ({ decision: 'ask', reason });
  if (!['Write', 'Edit', 'NotebookEdit'].includes(tool)) {
    return { decision: 'deny', reason: 'Unsupported file tool.' };
  }
  const target = tool === 'NotebookEdit' ? input.notebook_path : input.file_path;
  if (typeof target !== 'string' || !path.isAbsolute(target) || /[\x00-\x1f]/.test(target)
    || target.split(path.sep).some(part => part === '.' || part === '..')) {
    return ask('The file path must be an unambiguous absolute path.');
  }
  if (isProtected(target)) return ask('This file can change configuration, permissions, or credentials.');
  try {
    // Resolve the nearest existing ancestor for new files and directories.
    let ancestor = target;
    const suffix: string[] = [];
    while (true) {
      try {
        fs.lstatSync(ancestor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        suffix.unshift(path.basename(ancestor));
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new Error('No existing ancestor.');
        ancestor = parent;
      }
    }
    // Broken symlinks fail here, rather than being treated as new directories.
    const resolved = path.join(fs.realpathSync(ancestor), ...suffix);
    const stat = fs.statSync(ancestor);
    if (suffix.length ? !stat.isDirectory() : !stat.isFile() || stat.nlink > 1) {
      return ask('The target is not an ordinary file with a single link.');
    }
    if (isProtected(resolved)) return ask('The resolved file is protected.');
    const allowed = roots.some(root => fs.realpathSync(root) === root
      && contains(root, target) && contains(root, resolved));
    return allowed
      ? { decision: 'allow', reason: 'Ordinary file inside an authorized writable directory.' }
      : ask('The file is outside the authorized writable directories.');
  } catch {
    return ask('The file destination could not be verified.');
  }
}
