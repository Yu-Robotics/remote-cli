import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
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

export async function nestedGitFixture(fixture: Awaited<ReturnType<typeof gitFixture>>,
  relative = 'module', submodule = false, unborn = false): Promise<string> {
  const repository = submodule ? path.join(fixture.directory, `template-${randomUUID()}`) : path.join(fixture.root, relative);
  await fs.mkdir(repository, { recursive: true });
  await runGit(repository, ['init', '-b', 'main']);
  await runGit(repository, ['config', 'user.name', 'Test User']);
  await runGit(repository, ['config', 'user.email', 'test@example.com']);
  await fs.writeFile(path.join(repository, '.gitignore'), '.env\nignored/\n');
  await fs.writeFile(path.join(repository, 'local.txt'), 'first\nsecond\nthird\n');
  if (!unborn) {
    await runGit(repository, ['add', '.']);
    await runGit(repository, ['commit', '-m', 'Synthetic nested repository']);
  }
  if (submodule) {
    await runGit(fixture.root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', repository, relative]);
    await runGit(fixture.root, ['commit', '-m', 'Synthetic local submodule']);
  }
  return path.join(fixture.root, relative);
}

export async function repositoryState(root: string) {
  return { head: await gitText(root, ['rev-parse', 'HEAD']),
    index: await fs.readFile(path.resolve(root, await gitText(root, ['rev-parse', '--git-path', 'index']))) };
}
