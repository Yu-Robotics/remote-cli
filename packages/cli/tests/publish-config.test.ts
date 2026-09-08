import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const PKG_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf-8'));

describe('CLI package publish configuration', () => {
  describe('package.json required fields', () => {
    it('should have a scoped package name', () => {
      expect(pkg.name).toBe('@yu_robotics/remote-cli');
    });

    it('should have a valid version', () => {
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('should have a description', () => {
      expect(pkg.description).toBeTruthy();
    });

    it('should have main pointing to dist', () => {
      expect(pkg.main).toBe('dist/index.js');
    });

    it('should have types pointing to dist', () => {
      expect(pkg.types).toBe('dist/index.d.ts');
    });

    it('should have a bin entry', () => {
      expect(pkg.bin).toBeDefined();
      expect(pkg.bin['remote-cli']).toBe('./bin/remote-cli.js');
    });

    it('should have a license', () => {
      expect(pkg.license).toBe('MIT');
    });
  });

  describe('publish-specific fields', () => {
    it('should have files field to control package contents', () => {
      expect(pkg.files).toBeDefined();
      expect(pkg.files).toContain('dist');
      expect(pkg.files).toContain('bin');
    });

    it('should not include src or tests in files', () => {
      expect(pkg.files).not.toContain('src');
      expect(pkg.files).not.toContain('tests');
    });

    it('should have publishConfig with public access', () => {
      expect(pkg.publishConfig).toBeDefined();
      expect(pkg.publishConfig.access).toBe('public');
    });

    it('should have prepublishOnly script', () => {
      expect(pkg.scripts.prepublishOnly).toBeDefined();
      expect(pkg.scripts.prepublishOnly).toContain('build');
      expect(pkg.scripts.prepublishOnly).toContain('test');
    });

    it('should have engines field', () => {
      expect(pkg.engines).toBeDefined();
      expect(pkg.engines.node).toBeTruthy();
    });
  });

  describe('package metadata', () => {
    it('should have repository info', () => {
      expect(pkg.repository).toBeDefined();
      expect(pkg.repository.type).toBe('git');
      expect(pkg.repository.url).toBeTruthy();
      expect(pkg.repository.directory).toBe('packages/cli');
    });

    it('should have author', () => {
      expect(pkg.author).toBeTruthy();
    });

    it('should have keywords', () => {
      expect(pkg.keywords).toBeDefined();
      expect(pkg.keywords.length).toBeGreaterThan(0);
    });

    it('should have homepage', () => {
      expect(pkg.homepage).toBeTruthy();
    });

    it('should have bugs url', () => {
      expect(pkg.bugs).toBeDefined();
      expect(pkg.bugs.url).toBeTruthy();
    });
  });

  describe('dependency compatibility', () => {
    it('should use the Zod major version required by Claude Agent SDK', () => {
      expect(pkg.dependencies.zod).toMatch(/^\^4\./);
    });
  });

  describe('required files exist', () => {
    it('should have LICENSE file', () => {
      expect(existsSync(path.join(PKG_ROOT, 'LICENSE'))).toBe(true);
    });

    it('should have README.md file', () => {
      expect(existsSync(path.join(PKG_ROOT, 'README.md'))).toBe(true);
    });

    it('should have bin/remote-cli.js file', () => {
      expect(existsSync(path.join(PKG_ROOT, 'bin', 'remote-cli.js'))).toBe(true);
    });
  });

  describe('not marked as private', () => {
    it('should not have private flag', () => {
      expect(pkg.private).toBeUndefined();
    });
  });
});
