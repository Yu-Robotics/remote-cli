import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const PKG_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8'));

describe('Router package publish configuration', () => {
  it('declares a public package identity and license', () => {
    expect(pkg.name).toBe('@yu_robotics/remote-cli-router');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.description).toBeTruthy();
    expect(pkg.license).toBe('MIT');
    expect(pkg.private).toBeUndefined();
  });

  it('exposes built JavaScript, type declarations, and the Router binary', () => {
    expect(pkg.main).toBe('dist/cli.js');
    expect(pkg.types).toBe('dist/cli.d.ts');
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin['remote-cli-router']).toBe('./bin/remote-cli-router.js');
  });

  it('publishes only distribution assets with public access', () => {
    expect(pkg.files).toBeDefined();
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('bin');
    expect(pkg.files).not.toContain('src');
    expect(pkg.files).not.toContain('tests');
    expect(pkg.publishConfig).toBeDefined();
    expect(pkg.publishConfig.access).toBe('public');
  });

  it('requires build and test scripts and a Node engine declaration', () => {
    expect(pkg.scripts.prepublishOnly).toBeDefined();
    expect(pkg.scripts.prepublishOnly).toContain('build');
    expect(pkg.scripts.prepublishOnly).toContain('test');
    expect(pkg.engines).toBeDefined();
    expect(pkg.engines.node).toBeTruthy();
  });

  it('provides repository attribution and package discovery metadata', () => {
    expect(pkg.repository).toBeDefined();
    expect(pkg.repository.type).toBe('git');
    expect(pkg.repository.url).toBeTruthy();
    expect(pkg.repository.directory).toBe('packages/router');
    expect(pkg.author).toBeTruthy();
    expect(pkg.keywords).toBeDefined();
    expect(pkg.keywords.length).toBeGreaterThan(0);
    expect(pkg.homepage).toBeTruthy();
    expect(pkg.bugs).toBeDefined();
    expect(pkg.bugs.url).toBeTruthy();
  });

  it('ships the license, README, and executable entrypoint', () => {
    expect(existsSync(path.join(PKG_ROOT, 'LICENSE'))).toBe(true);
    expect(existsSync(path.join(PKG_ROOT, 'README.md'))).toBe(true);
    expect(existsSync(path.join(PKG_ROOT, 'bin', 'remote-cli-router.js'))).toBe(true);
  });
});
