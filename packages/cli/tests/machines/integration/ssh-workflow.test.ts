import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MachineCommands } from '../../../src/machines/MachineCommands'
import { BackupStore } from '../../../src/machines/BackupStore'
import { ConfigManager } from '../../../src/config/ConfigManager'
import type { MachineConfig } from '../../../src/machines/types'
import os from 'os'
import fs from 'fs/promises'
import path from 'path'

// Mock os.homedir() for test isolation
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || '/tmp')

describe('Integration: SSH Workflow', () => {
  let commands: MachineCommands
  let mockSsh: any
  let config: ConfigManager
  let backupStore: BackupStore
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-workflow-test-'))
    process.env.HOME = tmpDir

    config = await ConfigManager.initialize()
    backupStore = new BackupStore(config.getConfigDir())

    mockSsh = {
      execRemote: vi.fn().mockResolvedValue(''),
      readRemoteFile: vi.fn().mockResolvedValue('original content\n'),
      writeRemoteFile: vi.fn().mockResolvedValue(undefined),
      execInContainer: vi.fn().mockResolvedValue(''),
      readContainerFile: vi.fn().mockResolvedValue('container content\n'),
      writeContainerFile: vi.fn().mockResolvedValue(undefined),
    }

    commands = new MachineCommands(config, mockSsh, backupStore)
  })

  afterEach(async () => {
    delete process.env.HOME
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should support full workflow: proxy setup → add machine → search → view → replace → backup → restore', async () => {
    // Step 1: Set global proxy
    const proxyResult = await commands.setProxy('frps.xiaoyubot.com', 5002, 'frp.xiaoyu.ai', 'xiaoyu:pass')
    expect(proxyResult.success).toBe(true)

    // Step 2: Add a machine (just id + user, host auto-derived)
    const addResult = await commands.addMachine('a1-9', 'nvidia')
    expect(addResult.success).toBe(true)
    expect(addResult.output).toContain('a1-9.frp.xiaoyu.ai')

    // Verify machine persisted by reloading config
    const freshConfig = await ConfigManager.initialize()
    const machine = freshConfig.get('machines.a1-9') as MachineConfig
    expect(machine).toBeDefined()
    expect(machine.user).toBe('nvidia')
    expect(machine.port).toBe(22)

    // Step 3: List machines
    const listResult = await commands.listMachines()
    expect(listResult.success).toBe(true)
    expect(listResult.output).toContain('a1-9')
    expect(listResult.output).toContain('a1-9.frp.xiaoyu.ai')

    // Step 4: Show machine (proxy shown as global)
    const showResult = commands.showMachine('a1-9')
    expect(showResult.success).toBe(true)
    expect(showResult.output).toContain('a1-9.frp.xiaoyu.ai')
    expect(showResult.output).toContain('nvidia')
    expect(showResult.output).toContain('Proxy:')

    // Step 5: List containers
    mockSsh.execRemote.mockResolvedValueOnce(
      'abc123\ttraining\tUp 5 hours\tpytorch:latest\ndef456\tinference\tUp 2 hours\ttrt:latest\n'
    )
    const containersResult = await commands.listContainers('a1-9')
    expect(containersResult.success).toBe(true)
    expect(containersResult.output).toContain('abc123')
    expect(containersResult.output).toContain('training')

    // Step 6: Search files on host
    mockSsh.execRemote.mockResolvedValueOnce('/app/model.py\n/app/train.py\n/app/config.yaml\n')
    const searchResult = await commands.searchFiles('a1-9', '/app', '*.py')
    expect(searchResult.success).toBe(true)
    expect(searchResult.output).toContain('/app/model.py')
    expect(searchResult.output).toContain('/app/train.py')

    // Step 7: Search files in container
    mockSsh.execInContainer.mockResolvedValueOnce('/workspace/data.py\n')
    const containerSearchResult = await commands.searchFiles('a1-9', '/workspace', '*.py', 'abc123')
    expect(containerSearchResult.success).toBe(true)
    expect(containerSearchResult.output).toContain('container')

    // Step 8: View file on host
    mockSsh.readRemoteFile.mockResolvedValueOnce('learning_rate = 0.001\nbatch_size = 32\n')
    const viewResult = await commands.viewFile('a1-9', '/app/config.yaml')
    expect(viewResult.success).toBe(true)
    expect(viewResult.output).toContain('learning_rate')

    // Step 9: Initiate replace
    const replaceInit = commands.initiateReplace('a1-9', '/app/config.yaml')
    expect(replaceInit.success).toBe(true)
    expect(replaceInit.pending).toBeDefined()
    expect(replaceInit.output).toContain('Ready to replace')

    // Step 10: Execute replace with new content
    const newContent = 'learning_rate = 0.0001\nbatch_size = 64\n'
    const replaceResult = await commands.executeReplace(replaceInit.pending!, newContent)
    expect(replaceResult.success).toBe(true)
    expect(replaceResult.output).toContain('replaced successfully')
    expect(replaceResult.output).toContain('Backup saved')

    // Step 11: List backups
    const backupsResult = await commands.listBackups('a1-9')
    expect(backupsResult.success).toBe(true)
    expect(backupsResult.output).toContain('/app/config.yaml')

    // Step 12: Restore from backup
    const backups = await backupStore.findByMachine('a1-9')
    expect(backups).toHaveLength(1)
    const restoreResult = await commands.restoreBackup(
      'a1-9', backups[0].backupPath, '/app/config.yaml'
    )
    expect(restoreResult.success).toBe(true)
    expect(restoreResult.output).toContain('Restored')

    // Step 13: Remove machine
    const removeResult = await commands.removeMachine('a1-9')
    expect(removeResult.success).toBe(true)

    // Verify machine removed
    const finalConfig = await ConfigManager.initialize()
    expect(finalConfig.get('machines.a1-9')).toBeUndefined()
  })

  it('should handle container file operations end-to-end', async () => {
    await commands.addMachine('gpu-01', 'admin', 'pass')

    // View file in container
    mockSsh.readContainerFile.mockResolvedValueOnce('import torch\n')
    const viewResult = await commands.viewFile('gpu-01', '/workspace/model.py', 'abc123')
    expect(viewResult.success).toBe(true)
    expect(viewResult.output).toContain('container: abc123')

    // Replace file in container
    const replaceInit = commands.initiateReplace('gpu-01', '/workspace/model.py', 'abc123')
    expect(replaceInit.pending?.containerId).toBe('abc123')

    mockSsh.execRemote.mockResolvedValue('')
    mockSsh.execInContainer.mockResolvedValue('')
    mockSsh.writeContainerFile.mockResolvedValue(undefined)

    const replaceResult = await commands.executeReplace(replaceInit.pending!, 'import torch\nimport torch.nn as nn\n')
    expect(replaceResult.success).toBe(true)

    // Verify backup record includes containerId
    const backups = await backupStore.findByMachine('gpu-01')
    expect(backups).toHaveLength(1)
    expect(backups[0].containerId).toBe('abc123')
  })

  it('should handle errors gracefully in workflow', async () => {
    // Add machine
    await commands.addMachine('gpu-01', 'admin', 'pass')

    // Search with SSH failure
    mockSsh.execRemote.mockRejectedValueOnce(new Error('Connection refused'))
    const searchResult = await commands.searchFiles('gpu-01', '/app', '*.py')
    expect(searchResult.success).toBe(false)
    expect(searchResult.error).toContain('Connection refused')

    // View with auth failure
    mockSsh.readRemoteFile.mockRejectedValueOnce(new Error('SSH authentication failed'))
    const viewResult = await commands.viewFile('gpu-01', '/app/config.py')
    expect(viewResult.success).toBe(false)
    expect(viewResult.error).toContain('authentication failed')

    // Operations on non-existent machine
    const ghostSearch = await commands.searchFiles('ghost', '/app', '*.py')
    expect(ghostSearch.success).toBe(false)
    expect(ghostSearch.error).toContain('not found')
  })

  it('should validate input safety', async () => {
    await commands.addMachine('gpu-01', 'admin', 'pass')

    // Reject path with shell injection
    const result1 = await commands.searchFiles('gpu-01', '/app;rm -rf /', '*.py')
    expect(result1.success).toBe(false)

    const result2 = await commands.viewFile('gpu-01', '/app/$(evil)')
    expect(result2.success).toBe(false)

    // Reject machine ID with special chars
    const result3 = await commands.addMachine('bad;id', 'user', 'pass')
    expect(result3.success).toBe(false)
  })
})
