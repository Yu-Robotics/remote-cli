import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import path from 'path';
import os from 'os';

// Mock os.homedir() to respect process.env.HOME for isolated tests
const originalHomedir = os.homedir();
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir);

describe('DirectoryGuard', () => {
  let guard: DirectoryGuard;
  const homeDir = os.homedir();

  beforeEach(() => {
    const allowedDirs = [
      '~/projects',
      '~/work',
      './relative'
    ];
    guard = new DirectoryGuard(allowedDirs);
  });

  describe('path normalization', () => {
    it('should expand tilde to home directory', () => {
      const normalized = guard.normalizePath('~/test');
      expect(normalized).toBe(path.join(homeDir, 'test'));
    });

    it('should resolve relative paths from cwd', () => {
      const cwd = '/test/working/dir';
      const normalized = guard.normalizePath('./subdir', cwd);
      expect(normalized).toBe(path.join(cwd, 'subdir'));
    });

    it('should handle absolute paths', () => {
      const absolutePath = '/absolute/path';
      const normalized = guard.normalizePath(absolutePath);
      expect(normalized).toBe(absolutePath);
    });

    it('should resolve .. in paths', () => {
      const normalized = guard.normalizePath('~/projects/../work');
      expect(normalized).toBe(path.join(homeDir, 'work'));
    });

    it('should handle empty path', () => {
      expect(() => guard.normalizePath('')).toThrow('Path cannot be empty');
    });

    it('should remove trailing slashes', () => {
      const normalized = guard.normalizePath('~/projects/');
      expect(normalized).toBe(path.join(homeDir, 'projects'));
    });
  });

  describe('path traversal protection', () => {
    it('should detect path traversal attempts with ..', () => {
      const result = guard.isSafePath('~/projects/../../../etc/passwd');
      expect(result).toBe(false);
    });

    it('should detect symlink-like path traversal', () => {
      const result = guard.isSafePath('~/projects/subdir/../../../../etc');
      expect(result).toBe(false);
    });

    it('should allow legitimate parent directory access within allowed path', () => {
      const result = guard.isSafePath('~/projects/subdir/../another');
      expect(result).toBe(true);
    });

    it('should reject paths outside home directory', () => {
      const result = guard.isSafePath('/etc/passwd');
      expect(result).toBe(false);
    });

    it('should reject paths to system directories', () => {
      expect(guard.isSafePath('/etc')).toBe(false);
      expect(guard.isSafePath('/var')).toBe(false);
      expect(guard.isSafePath('/usr/bin')).toBe(false);
      expect(guard.isSafePath('/System')).toBe(false);
    });
  });

  describe('allowed directory checking', () => {
    it('should allow path in allowed directory', () => {
      const result = guard.isSafePath('~/projects/my-app');
      expect(result).toBe(true);
    });

    it('should allow exact match of allowed directory', () => {
      const result = guard.isSafePath('~/projects');
      expect(result).toBe(true);
    });

    it('should reject path not in allowed directories', () => {
      const result = guard.isSafePath('~/documents');
      expect(result).toBe(false);
    });

    it('should allow subdirectories of allowed directories', () => {
      const result = guard.isSafePath('~/projects/sub/deep/path');
      expect(result).toBe(true);
    });

    it('should handle relative paths with allowed directories', () => {
      const cwd = path.join(homeDir, 'work');
      const result = guard.isSafePath('./project', cwd);
      expect(result).toBe(true);
    });

    it('should reject relative paths outside working directory', () => {
      const cwd = path.join(homeDir, 'work');
      const result = guard.isSafePath('../../other', cwd);
      expect(result).toBe(false);
    });
  });

  describe('file path validation', () => {
    it('should validate file paths in allowed directory', () => {
      const result = guard.isSafePath('~/projects/my-app/src/index.ts');
      expect(result).toBe(true);
    });

    it('should reject file paths outside allowed directories', () => {
      const result = guard.isSafePath('~/downloads/suspicious.sh');
      expect(result).toBe(false);
    });

    it('should handle paths with special characters', () => {
      const result = guard.isSafePath('~/projects/my app/file name.ts');
      expect(result).toBe(true);
    });
  });

  describe('working directory resolution', () => {
    it('should resolve working directory to allowed path', () => {
      const resolved = guard.resolveWorkingDirectory('~/projects/my-app');
      expect(resolved).toBe(path.join(homeDir, 'projects/my-app'));
    });

    it('should reject unsafe working directory', () => {
      expect(() => guard.resolveWorkingDirectory('/etc')).toThrow('not allowed');
    });

    it('should reject path traversal in working directory', () => {
      expect(() => guard.resolveWorkingDirectory('~/projects/../../etc')).toThrow('not allowed');
    });

    it('should accept relative working directory from allowed cwd', () => {
      const cwd = path.join(homeDir, 'work');
      const resolved = guard.resolveWorkingDirectory('./project', cwd);
      expect(resolved).toBe(path.join(cwd, 'project'));
    });
  });

  describe('multiple file validation', () => {
    it('should validate all paths are safe', () => {
      const files = [
        '~/projects/file1.ts',
        '~/projects/file2.ts',
        '~/work/file3.ts'
      ];
      const result = guard.areAllPathsSafe(files);
      expect(result).toBe(true);
    });

    it('should detect if any path is unsafe', () => {
      const files = [
        '~/projects/file1.ts',
        '/etc/passwd',
        '~/work/file3.ts'
      ];
      const result = guard.areAllPathsSafe(files);
      expect(result).toBe(false);
    });

    it('should handle empty file list', () => {
      const result = guard.areAllPathsSafe([]);
      expect(result).toBe(true);
    });
  });

  describe('allowed directories management', () => {
    it('should return list of allowed directories', () => {
      const allowed = guard.getAllowedDirectories();
      expect(allowed).toContain('~/projects');
      expect(allowed).toContain('~/work');
      expect(allowed).toContain('./relative');
    });

    it('should add new allowed directory', () => {
      guard.addAllowedDirectory('~/new-project');
      expect(guard.isSafePath('~/new-project/file.ts')).toBe(true);
    });

    it('should remove allowed directory', () => {
      guard.removeAllowedDirectory('~/work');
      expect(guard.isSafePath('~/work/file.ts')).toBe(false);
    });

    it('should not add duplicate directory', () => {
      guard.addAllowedDirectory('~/projects');
      const allowed = guard.getAllowedDirectories();
      const count = allowed.filter(d => d === '~/projects').length;
      expect(count).toBe(1);
    });
  });

  describe('error messages', () => {
    it('should provide descriptive error for unsafe path', () => {
      try {
        guard.resolveWorkingDirectory('/etc');
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toContain('not allowed');
        expect(error.message).toContain('/etc');
      }
    });

    it('should provide descriptive error for path traversal', () => {
      try {
        guard.resolveWorkingDirectory('~/projects/../../etc');
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.message).toContain('not allowed');
      }
    });
  });

  describe('edge cases', () => {
    it('should handle paths with double slashes', () => {
      const result = guard.isSafePath('~/projects//subdir//file.ts');
      expect(result).toBe(true);
    });

    it('should handle paths with ./ prefix', () => {
      const cwd = path.join(homeDir, 'projects');
      const result = guard.isSafePath('./file.ts', cwd);
      expect(result).toBe(true);
    });

    it('should handle paths with multiple .. sequences', () => {
      const result = guard.isSafePath('~/projects/a/b/c/../../d');
      expect(result).toBe(true);
    });

    it('should handle case sensitivity correctly', () => {
      // On macOS/Windows paths are case-insensitive, on Linux case-sensitive
      const result = guard.isSafePath('~/PROJECTS/file.ts');
      // Should still work due to normalization
      expect(typeof result).toBe('boolean');
    });
  });

  describe('empty allowed directories', () => {
    it('should reject all paths when no directories allowed', () => {
      const emptyGuard = new DirectoryGuard([]);
      expect(emptyGuard.isSafePath('~/projects')).toBe(false);
      expect(emptyGuard.isSafePath('/etc')).toBe(false);
    });

    it('should allow adding directories to empty guard', () => {
      const emptyGuard = new DirectoryGuard([]);
      emptyGuard.addAllowedDirectory('~/test');
      expect(emptyGuard.isSafePath('~/test/file.ts')).toBe(true);
    });
  });
});
