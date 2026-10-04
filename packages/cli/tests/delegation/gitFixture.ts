import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { gitText, runGit } from '../../src/delegation/GitCheckpoint';

export async function gitFixture() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegated-git-test-')));
  const root = path.join(directory, 'repository');
  await fs.mkdir(root);
  await runGit(root, ['init', '-b', 'main']);
  await runGit(root, ['config', 'user.name', 'Test User']);
  await runGit(root, ['config', 'user.email', 'test@example.com']);
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n.env\n');
  await fs.writeFile(path.join(root, 'source.txt'), 'first\nsecond\nthird\n');
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested', 'local.txt'), 'nested\n');
  await runGit(root, ['add', '.']);
  await runGit(root, ['commit', '-m', 'Initial synthetic fixture']);
  return { directory, root, head: await gitText(root, ['rev-parse', 'HEAD']) };
}
