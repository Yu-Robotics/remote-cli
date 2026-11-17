import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detachAgySelection } from '../../src/executor/agy/AgySessionSelection';
let root: string, pointer: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-selection-')));
  vi.spyOn(os, 'homedir').mockReturnValue(root); vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root);
  pointer = path.join(root, 'session.json');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
it('preserves legacy pointers and refuses malformed ACP selections without inventing a fresh binding', () => {
  expect(detachAgySelection(pointer)).toBe(false);
  fs.writeFileSync(pointer, JSON.stringify({ id: 'legacy' })); expect(detachAgySelection(pointer)).toBe(false);
  fs.writeFileSync(pointer, '{'); expect(() => detachAgySelection(pointer)).toThrow(); expect(fs.readFileSync(pointer, 'utf8')).toBe('{');
  fs.writeFileSync(pointer, JSON.stringify({ transport: 'acp' })); expect(() => detachAgySelection(pointer)).toThrow('Invalid');
});
it.each(['.checkpoint.lock', '.native-schedules', '.allocation-unconfirmed'])('retains the selected ACP session while %s exists', suffix => {
  const data = JSON.stringify({ id: 'synthetic-session', transport: 'acp' }); fs.writeFileSync(pointer, data);
  fs.writeFileSync(pointer + suffix, 'synthetic-evidence'); expect(() => detachAgySelection(pointer)).toThrow();
  expect(fs.readFileSync(pointer, 'utf8')).toBe(data);
});
it('archives exact selection and legacy checkpoint while leaving native history untouched', () => {
  const session = { id: 'synthetic-session', transport: 'acp', retired: true };
  fs.writeFileSync(pointer, JSON.stringify(session)); fs.writeFileSync(pointer + '.checkpoint', 'legacy proof');
  fs.writeFileSync(path.join(root, 'history'), 'old native history'); expect(detachAgySelection(pointer)).toBe(true);
  const archive = pointer + '.detached-acp', name = fs.readdirSync(archive)[0];
  expect(JSON.parse(fs.readFileSync(path.join(archive, name), 'utf8'))).toEqual({ session, retirement: 'unconfirmed', legacyCheckpoint: 'legacy proof' });
  expect(fs.readFileSync(path.join(root, 'history'), 'utf8')).toBe('old native history'); expect(fs.existsSync(pointer)).toBe(false);
});
