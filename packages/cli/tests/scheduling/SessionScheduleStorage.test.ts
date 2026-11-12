import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import ts from 'typescript';
import { sessionSchedulePatch } from '../../src/scheduling/dsh/sessionLaunch';

describe('native schedule storage composition', () => {
  const roots: string[] = [];
  afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
  it('loads the public backend from the native executable installation and unregisters it on disposal', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-storage-module-'))); roots.push(root);
    const entry = path.join(root, 'bin.js'); await fs.writeFile(entry, '');
    const module = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-storage-json'); await fs.mkdir(module, { recursive: true });
    await fs.writeFile(path.join(module, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-storage-json', type: 'module', exports: './index.js' }));
    await fs.writeFile(path.join(module, 'index.js'), 'export class JsonStorageBackend { constructor(root) { this.root=root; } async close() { this.closed=true; } }');
    const source = await fs.readFile(path.resolve(__dirname, '../../src/scheduling/dsh/SessionScheduleStorage.ts'), 'utf8');
    await fs.writeFile(path.join(root, 'adapter.cjs'), ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText);
    await fs.writeFile(entry, `const assert = require('node:assert/strict');
      let disposed, backend, unregistered = false;
      const ctx = { storage: { backend: { register(name, value) { assert.equal(name, 'remoteCliSessionSchedule'); backend=value; return () => { unregistered=true; }; } } },
        effect(body) { disposed=body(); }, provide() {} };
      require('./adapter.cjs').apply(ctx, {directory: __dirname}).then(async () => {
        assert.equal(backend.root, __dirname); await disposed(); assert.equal(backend.closed, true); assert.equal(unregistered, true);
      }).catch(error => { console.error(error); process.exitCode=1; });`);
    expect(() => execFileSync(process.execPath, [entry], { timeout: 10000, stdio: 'pipe' })).not.toThrow();
    const patch = sessionSchedulePatch(root, 'synthetic-scope');
    expect(patch).toContain('remoteCliSessionSchedule'); expect(patch).not.toContain('session-persistence-jsonl');
    expect(patch).not.toContain('tool-schedule');
  });
});
