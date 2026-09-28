import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => process.env.REMOTE_CLI_TEST_AGY_HOME ?? actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});
import { configureAgyDelegation } from '../../src/executor/agy/AgyDelegationConfig';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

const originalHome = os.homedir();
const fixture = String.raw`
const fs = require('fs'),path = require('path');
const file = path.join(process.env.HOME,'.gemini/config/mcp_config.json');
if (process.argv[2] === 'mcp') {
  if (process.env.TEST_MCP_FAILURE) process.exit(2);
  const config = JSON.parse(fs.readFileSync(file,'utf8'));
  config.mcpServers ||= {};
  config.mcpServers[process.argv[4]] = {command:process.argv[5],args:process.argv.slice(6)};
  fs.writeFileSync(file,JSON.stringify(config)); process.exit(0);
}
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {};
const conversationDir=path.join(process.env.HOME,'.gemini/antigravity-cli/conversations');
fs.mkdirSync(conversationDir,{recursive:true});fs.writeFileSync(path.join(conversationDir,'conversation.db'),'');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
require('readline').createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line);if(message.message.content === 'wait') return;
  send({event:'init',conversation_id:'conversation'});
  const enabled=!!config.mcpServers?.['remote-cli-delegation'] && !!process.env.REMOTE_CLI_DELEGATION_TOKEN;
  send({event:'step_update',step_update:{step_index:1,step_type:'agent_response',text_delta:enabled?'delegation enabled':'delegation disabled'}});
  send({event:'result',result:{status:'SUCCESS'}});
});
`;

describe('AGY thread-local delegation configuration', () => {
  let home: string;
  let command: string;
  let original: string;
  const executors: AgyExecutor[] = [];
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(originalHome, '.agy-delegation-test-')));
    vi.stubEnv('REMOTE_CLI_TEST_AGY_HOME', home);
    command = path.join(home, 'agy');
    fs.writeFileSync(command, `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
    fs.mkdirSync(path.join(home, '.gemini/config'), { recursive: true });
    original = JSON.stringify({ mcpServers: { personal: { command: '/personal', enabledTools: ['read'] } }, custom: true });
    fs.writeFileSync(path.join(home, '.gemini/config/mcp_config.json'), original);
    fs.writeFileSync(path.join(home, '.gemini/config/hooks.json'), '{"hooks":{}}');
    fs.renameSync(path.join(home, '.gemini/config'), path.join(home, 'shared-config'));
    fs.symlinkSync(path.join(home, 'shared-config'), path.join(home, '.gemini/config'), 'dir');
  });
  afterEach(async () => {
    for (const executor of executors.splice(0)) { await executor.destroy(); await executor.waitForExit(); }
    vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true });
  });
  const makeExecutor = (home: string, command: string, id: string) => {
    const executor = new AgyExecutor(new DirectoryGuard([home]), { agyCommand: command,
      initialWorkingDirectory: home, threadId: id });
    executors.push(executor); return executor;
  };

  it('registers only in the coordinator HOME and restores the original config on opt-out', async () => {
    const executor = makeExecutor(home, command, 'coordinator');
    const connection = { url: 'http://127.0.0.1:1/', token: 'never-persist-this' };
    await executor.configureDelegation(connection);
    const privateConfig = path.join(home, '.remote-cli/agy-homes/coordinator/.gemini/config/mcp_config.json');
    const config = JSON.parse(fs.readFileSync(privateConfig, 'utf8'));
    expect(config.mcpServers.personal).toEqual(JSON.parse(original).mcpServers.personal);
    expect(config.mcpServers['remote-cli-delegation'].command).toBe(process.execPath);
    expect(fs.readFileSync(privateConfig, 'utf8')).not.toContain(connection.token);
    expect(fs.statSync(privateConfig).mode & 0o777).toBe(0o600);
    expect(await executor.execute('hello')).toMatchObject({ success: true, output: 'delegation enabled' });
    expect(await makeExecutor(home, command, 'worker').execute('hello')).toMatchObject({ success: true, output: 'delegation disabled' });
    await executor.configureDelegation(undefined);
    expect(await executor.execute('continue')).toMatchObject({ success: true, output: 'delegation disabled' });
    expect(fs.lstatSync(path.dirname(privateConfig)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(privateConfig, 'utf8')).toBe(original);
    expect(fs.readFileSync(path.join(home, '.gemini/config/mcp_config.json'), 'utf8')).toBe(original);
    expect(fs.realpathSync(path.join(path.dirname(privateConfig), 'hooks.json'))).toBe(fs.realpathSync(path.join(home, '.gemini/config/hooks.json')));
    fs.writeFileSync(path.join(home, '.gemini/config/new-setting.json'), '{}');
    expect(fs.existsSync(path.join(path.dirname(privateConfig), 'new-setting.json'))).toBe(true);
  });

  it('removes stale registration after recreation with delegation disabled', async () => {
    const threadHome = path.join(home, 'thread');
    fs.mkdirSync(path.join(threadHome, '.gemini'), { recursive: true });
    fs.symlinkSync(path.join(home, '.gemini/config'), path.join(threadHome, '.gemini/config'));
    await configureAgyDelegation(command, threadHome, true);
    await configureAgyDelegation(command, threadHome, true);
    await configureAgyDelegation(command, threadHome, false);
    await configureAgyDelegation(command, threadHome, false);
    expect(fs.readFileSync(path.join(threadHome, '.gemini/config/mcp_config.json'), 'utf8')).toBe(original);
  });

  it('restores a private config if the native MCP command fails', async () => {
    const threadHome = path.join(home, 'thread');
    const directory = path.join(threadHome, '.gemini/config');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'mcp_config.json'), original);
    await expect(configureAgyDelegation('/missing/agy', threadHome, true)).rejects.toThrow('native');
    expect(fs.readFileSync(path.join(directory, 'mcp_config.json'), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(directory, '.remote-cli-delegation-original.json'))).toBe(false);
    await configureAgyDelegation(command, threadHome, true);
    await configureAgyDelegation(command, threadHome, false);
    expect(fs.readFileSync(path.join(directory, 'mcp_config.json'), 'utf8')).toBe(original);
  });

  it('does not require a global MCP file and cleans up a newly created one', async () => {
    const threadHome = path.join(home, 'empty');
    await configureAgyDelegation(command, threadHome, false);
    expect(fs.existsSync(threadHome)).toBe(false);
    await configureAgyDelegation(command, threadHome, true);
    await configureAgyDelegation(command, threadHome, false);
    expect(fs.existsSync(path.join(threadHome, '.gemini/config/mcp_config.json'))).toBe(false);
  });
});
