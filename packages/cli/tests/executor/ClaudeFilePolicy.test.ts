import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { evaluateFileWrite } from '../../src/executor/claude/ClaudeFilePolicy';

describe('Claude file write policy', () => {
  let root: string;
  let project: string;
  let extra: string;
  let roots: string[];
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-policy-')));
    project = path.join(root, 'project');
    extra = path.join(root, 'extra');
    for (const directory of [project, extra]) fs.mkdirSync(directory);
    roots = [project, extra];
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each(['Write', 'Edit', 'NotebookEdit'])('allows %s for ordinary existing and new files in either writable root', tool => {
    for (const directory of roots) {
      const existing = path.join(directory, 'existing.txt');
      fs.writeFileSync(existing, 'old');
      for (const target of [existing, path.join(directory, 'new', 'nested', 'file.txt')]) {
        const input = { [tool === 'NotebookEdit' ? 'notebook_path' : 'file_path']: target };
        expect(evaluateFileWrite(tool, input, roots).decision).toBe('allow');
      }
    }
  });

  it('asks for outside paths, prefix collisions, relative paths, and traversal', () => {
    for (const target of [path.join(root, 'other.txt'), `${project}-other/file`, 'file.txt', `${project}/../outside`, '']) {
      expect(evaluateFileWrite('Write', { file_path: target }, roots).decision).toBe('ask');
    }
  });

  it('asks for protected configuration, credentials, and repository metadata in every writable root', () => {
    for (const directory of roots) {
      for (const file of ['.claude/settings.json', '.git/config', '.config/git/config', '.claude.json', '.mcp.json', '.remote-cli/config.json', '.env', '.env.local', '.bashrc', '.husky/pre-commit', 'pyrightconfig.json']) {
        expect(evaluateFileWrite('Write', { file_path: path.join(directory, file) }, roots).decision).toBe('ask');
      }
    }
  });

  it('allows ordinary worktree files while protecting their local configuration', () => {
    const worktree = path.join(project, '.claude', 'worktrees', 'feature');
    expect(evaluateFileWrite('Write', { file_path: path.join(worktree, 'src', 'app.ts') }, roots).decision).toBe('allow');
    expect(evaluateFileWrite('Write', { file_path: path.join(worktree, '.claude', 'settings.json') }, roots).decision).toBe('ask');
  });

  it('checks symlink destinations for existing files, new files, and protected aliases', () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'existing'), 'outside');
    fs.symlinkSync(outside, path.join(project, 'link'));
    for (const filename of ['existing', 'new', 'nested/new']) {
      expect(evaluateFileWrite('Write', { file_path: path.join(project, 'link', filename) }, roots).decision).toBe('ask');
    }
    fs.mkdirSync(path.join(project, '.claude'));
    fs.symlinkSync(path.join(project, '.claude'), path.join(project, 'alias'));
    expect(evaluateFileWrite('Write', { file_path: path.join(project, 'alias', 'settings.json') }, roots).decision).toBe('ask');
    fs.symlinkSync(path.join(root, 'missing'), path.join(project, 'broken'));
    expect(evaluateFileWrite('Write', { file_path: path.join(project, 'broken', 'new') }, roots).decision).toBe('ask');
  });

  it('does not auto-approve hard links or a writable root replaced by a symlink', () => {
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'outside');
    const hardlink = path.join(project, 'hardlink');
    fs.linkSync(outside, hardlink);
    expect(evaluateFileWrite('Edit', { file_path: hardlink }, roots).decision).toBe('ask');
    fs.rmdirSync(extra);
    fs.symlinkSync(project, extra);
    expect(evaluateFileWrite('Write', { file_path: path.join(extra, 'new') }, roots).decision).toBe('ask');
  });

  it('never permits unknown tools or missing write paths', () => {
    expect(evaluateFileWrite('Bash', { file_path: path.join(project, 'file') }, roots).decision).toBe('deny');
    expect(evaluateFileWrite('NotebookEdit', { file_path: path.join(project, 'file') }, roots).decision).toBe('ask');
    expect(evaluateFileWrite('Write', { file_path: path.join(project, 'file') }, []).decision).toBe('ask');
  });
});
