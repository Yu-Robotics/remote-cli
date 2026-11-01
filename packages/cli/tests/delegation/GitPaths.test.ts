import path from 'path';
import { describe, expect, it } from 'vitest';
import { nativeGitPath } from '../../src/delegation/GitPaths';

describe('native Git path syntax', () => {
  it('normalizes Windows drive and UNC separators without merging distinct paths', () => {
    expect(nativeGitPath('C:/fixture/worker', path.win32)).toBe('C:\\fixture\\worker');
    expect(nativeGitPath('//server/share/worker', path.win32)).toBe('\\\\server\\share\\worker');
    expect(nativeGitPath('C:/fixture/other', path.win32)).not.toBe('C:\\fixture\\worker');
    expect(nativeGitPath('D:/fixture/worker', path.win32)).not.toBe('C:\\fixture\\worker');
    expect(nativeGitPath('c:/Fixture/worker', path.win32)).toBe('c:\\Fixture\\worker');
  });

  it('preserves POSIX case and literal backslashes', () => {
    expect(nativeGitPath('/fixture/Worker', path.posix)).toBe('/fixture/Worker');
    expect(nativeGitPath('/fixture/./Worker', path.posix)).toBe('/fixture/./Worker');
    expect(nativeGitPath('/fixture/Worker/', path.posix)).toBe('/fixture/Worker/');
    expect(nativeGitPath('/fixture/worker\\name', path.posix)).toBe('/fixture/worker\\name');
    expect(nativeGitPath('/fixture/other', path.posix)).not.toBe('/fixture/worker');
  });
});
