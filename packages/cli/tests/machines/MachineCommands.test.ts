import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MachineCommands } from '../../src/machines/MachineCommands'
import { SshExecutor } from '../../src/machines/SshExecutor'
import { BackupStore } from '../../src/machines/BackupStore'
import { ConfigManager } from '../../src/config/ConfigManager'
import type { MachineConfig } from '../../src/machines/types'
import os from 'os'
import fs from 'fs/promises'
import path from 'path'

// Mock os.homedir() for test isolation
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || '/tmp')

describe('MachineCommands', () => {
  let commands: MachineCommands
  let mockSsh: any
  let config: ConfigManager
  let backupStore: BackupStore
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'machine-cmd-test-'))
    process.env.HOME = tmpDir

    config = await ConfigManager.initialize()
    backupStore = new BackupStore(config.getConfigDir())

    mockSsh = {
      execRemote: vi.fn().mockResolvedValue(''),
      readRemoteFile: vi.fn().mockResolvedValue('file content'),
      writeRemoteFile: vi.fn().mockResolvedValue(undefined),
      execInContainer: vi.fn().mockResolvedValue(''),
      readContainerFile: vi.fn().mockResolvedValue('container content'),
      writeContainerFile: vi.fn().mockResolvedValue(undefined),
    }

    commands = new MachineCommands(config, mockSsh, backupStore)
  })

  afterEach(async () => {
    delete process.env.HOME
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('setProxy / showProxy', () => {
    it('should set global proxy config', async () => {
      const result = await commands.setProxy('frps.xiaoyubot.com', 5002, 'frp.xiaoyu.ai', 'xiaoyu:pass')
      expect(result.success).toBe(true)
      expect(result.output).toContain('frps.xiaoyubot.com:5002')
      expect(result.output).toContain('frp.xiaoyu.ai')

      const freshConfig = await ConfigManager.initialize()
      const remote = freshConfig.get('remote') as any
      expect(remote.proxy.host).toBe('frps.xiaoyubot.com')
      expect(remote.proxy.port).toBe(5002)
      expect(remote.hostSuffix).toBe('frp.xiaoyu.ai')
    })

    it('should show proxy when configured', async () => {
      await commands.setProxy('frps.xiaoyubot.com', 5002, 'frp.xiaoyu.ai', 'xiaoyu:pass')

      const result = commands.showProxy()
      expect(result.success).toBe(true)
      expect(result.output).toContain('frps.xiaoyubot.com:5002')
      expect(result.output).toContain('frp.xiaoyu.ai')
      expect(result.output).toContain('Auth:')
    })

    it('should show default proxy when not configured', () => {
      const result = commands.showProxy()
      expect(result.success).toBe(true)
      expect(result.output).toContain('frps.xiaoyubot.com:5002')
      expect(result.output).toContain('(default)')
      expect(result.output).toContain('frp.xiaoyu.ai')
    })

    it('should set proxy without auth', async () => {
      const result = await commands.setProxy('proxy.example.com', 8080, 'example.com')
      expect(result.success).toBe(true)

      const freshConfig = await ConfigManager.initialize()
      const remote = freshConfig.get('remote') as any
      expect(remote.proxy.auth).toBeUndefined()
    })
  })

  describe('listMachines', () => {
    it('should return no machines message when empty', async () => {
      const result = await commands.listMachines()
      expect(result.success).toBe(true)
      expect(result.output).toContain('No machines configured')
    })

    it('should list configured machines with derived host', async () => {
      await config.set('remote', {
        proxy: { host: 'frps.xiaoyubot.com', port: 5002 },
        hostSuffix: 'frp.xiaoyu.ai',
      })
      await config.set('machines.a1-9', {
        user: 'nvidia', port: 22,
      })

      const result = await commands.listMachines()
      expect(result.success).toBe(true)
      expect(result.output).toContain('a1-9')
      expect(result.output).toContain('a1-9.frp.xiaoyu.ai')
      expect(result.output).toContain('nvidia')
    })

    it('should list machines with default host suffix', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })

      const result = await commands.listMachines()
      expect(result.success).toBe(true)
      expect(result.output).toContain('prod')
      expect(result.output).toContain('prod.frp.xiaoyu.ai')
      expect(result.output).toContain('admin')
    })
  })

  describe('addMachine', () => {
    it('should add a machine to config', async () => {
      const result = await commands.addMachine('prod', 'admin', 'pass123')

      expect(result.success).toBe(true)
      expect(result.output).toContain('Machine "prod" added')

      const freshConfig = await ConfigManager.initialize()
      const machine = freshConfig.get('machines.prod') as MachineConfig
      expect(machine.user).toBe('admin')
      expect(machine.password).toBe('pass123')
      expect(machine.port).toBe(22)
    })

    it('should add machine without password (key-based auth)', async () => {
      const result = await commands.addMachine('dev', 'root')

      expect(result.success).toBe(true)
      const freshConfig = await ConfigManager.initialize()
      const machine = freshConfig.get('machines.dev') as MachineConfig
      expect(machine.user).toBe('root')
      expect(machine.password).toBeUndefined()
    })

    it('should accept custom port', async () => {
      const result = await commands.addMachine('dev', 'root', 'pass', 2222)

      expect(result.success).toBe(true)
      const freshConfig = await ConfigManager.initialize()
      const machine = freshConfig.get('machines.dev') as MachineConfig
      expect(machine.port).toBe(2222)
    })

    it('should show derived host when suffix is configured', async () => {
      await config.set('remote', {
        proxy: { host: 'frps.xiaoyubot.com', port: 5002 },
        hostSuffix: 'frp.xiaoyu.ai',
      })

      const result = await commands.addMachine('a1-9', 'nvidia')
      expect(result.success).toBe(true)
      expect(result.output).toContain('a1-9.frp.xiaoyu.ai')
    })

    it('should reject invalid machine id', async () => {
      const result = await commands.addMachine('bad;id', 'admin', 'pass')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid arguments')
    })
  })

  describe('removeMachine', () => {
    it('should remove an existing machine', async () => {
      await commands.addMachine('prod', 'admin', 'pass')
      const result = await commands.removeMachine('prod')

      expect(result.success).toBe(true)
      expect(result.output).toContain('removed')

      const freshConfig = await ConfigManager.initialize()
      expect(freshConfig.get('machines.prod')).toBeUndefined()
    })

    it('should return error for unknown machine', async () => {
      const result = await commands.removeMachine('ghost')
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })
  })

  describe('showMachine', () => {
    it('should show machine with masked password and default proxy', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'secret', port: 22,
      })

      const result = commands.showMachine('prod')
      expect(result.success).toBe(true)
      expect(result.output).toContain('admin')
      expect(result.output).toContain('******')
      expect(result.output).not.toContain('secret')
      expect(result.output).toContain('Proxy:')
    })

    it('should show machine with global proxy info', async () => {
      await config.set('remote', {
        proxy: { host: 'frps.xiaoyubot.com', port: 5002, auth: 'xiaoyu:pass' },
        hostSuffix: 'frp.xiaoyu.ai',
      })
      await config.set('machines.a1-9', {
        user: 'nvidia', port: 22,
      })

      const result = commands.showMachine('a1-9')
      expect(result.success).toBe(true)
      expect(result.output).toContain('a1-9.frp.xiaoyu.ai')
      expect(result.output).toContain('nvidia')
      expect(result.output).toContain('Proxy:')
      expect(result.output).toContain('frps.xiaoyubot.com:5002')
    })

    it('should return error for unknown machine', () => {
      const result = commands.showMachine('ghost')
      expect(result.success).toBe(false)
    })
  })

  describe('listContainers', () => {
    it('should list containers from remote machine', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })
      mockSsh.execRemote.mockResolvedValue('abc123\tweb\tUp 2 hours\tnginx:latest\n')

      const result = await commands.listContainers('prod')
      expect(result.success).toBe(true)
      expect(result.output).toContain('abc123')
      expect(result.output).toContain('web')
      expect(mockSsh.execRemote).toHaveBeenCalledWith(
        expect.objectContaining({ user: 'admin' }),
        expect.arrayContaining(['docker', 'ps']),
      )
    })

    it('should handle no containers', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })
      mockSsh.execRemote.mockResolvedValue('')

      const result = await commands.listContainers('prod')
      expect(result.success).toBe(true)
      expect(result.output).toContain('No running containers')
    })

    it('should return error for unknown machine', async () => {
      const result = await commands.listContainers('ghost')
      expect(result.success).toBe(false)
    })
  })

  describe('searchFiles', () => {
    it('should search files on host', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })
      mockSsh.execRemote.mockResolvedValue('/app/main.py\n/app/utils.py\n')

      const result = await commands.searchFiles('prod', '/app', '*.py')
      expect(result.success).toBe(true)
      expect(result.output).toContain('/app/main.py')
      expect(result.output).toContain('/app/utils.py')
    })

    it('should search in container', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })
      mockSsh.execInContainer.mockResolvedValue('/app/test.py\n')

      const result = await commands.searchFiles('prod', '/app', '*.py', 'abc123')
      expect(result.success).toBe(true)
      expect(result.output).toContain('container')
      expect(mockSsh.execInContainer).toHaveBeenCalled()
    })

    it('should truncate results beyond 200', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })
      const manyFiles = Array.from({ length: 250 }, (_, i) => `/app/file${i}.py`).join('\n')
      mockSsh.execRemote.mockResolvedValue(manyFiles)

      const result = await commands.searchFiles('prod', '/app', '*.py')
      expect(result.success).toBe(true)
      expect(result.output).toContain('truncated')
    })

    it('should reject unsafe paths', async () => {
      const result = await commands.searchFiles('prod', '/app;rm -rf /', '*.py')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid arguments')
    })
  })

  describe('viewFile', () => {
    it('should view file on host', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })
      mockSsh.readRemoteFile.mockResolvedValue('print("hello")\n')

      const result = await commands.viewFile('prod', '/app/main.py')
      expect(result.success).toBe(true)
      expect(result.output).toContain('print("hello")')
      expect(mockSsh.readRemoteFile).toHaveBeenCalledWith(
        expect.any(Object), '/app/main.py', 100
      )
    })

    it('should view file in container', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })
      mockSsh.readContainerFile.mockResolvedValue('config_value = 1\n')

      const result = await commands.viewFile('prod', '/app/config.py', 'abc123', 50)
      expect(result.success).toBe(true)
      expect(result.output).toContain('container')
      expect(mockSsh.readContainerFile).toHaveBeenCalledWith(
        expect.any(Object), 'abc123', '/app/config.py', 50
      )
    })

    it('should respect custom line count', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })

      await commands.viewFile('prod', '/app/main.py', undefined, 20)
      expect(mockSsh.readRemoteFile).toHaveBeenCalledWith(
        expect.any(Object), '/app/main.py', 20
      )
    })
  })

  describe('initiateReplace', () => {
    it('should return pending state for valid request', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })

      const result = commands.initiateReplace('prod', '/app/config.py')
      expect(result.success).toBe(true)
      expect(result.output).toContain('Ready to replace')
      expect(result.pending).toBeDefined()
      expect(result.pending?.machineId).toBe('prod')
      expect(result.pending?.filePath).toBe('/app/config.py')
    })

    it('should return error for unknown machine', () => {
      const result = commands.initiateReplace('ghost', '/app/file.py')
      expect(result.success).toBe(false)
    })

    it('should reject unsafe file paths', async () => {
      await config.set('machines.prod', {
        user: 'admin', port: 22,
      })
      const result = commands.initiateReplace('prod', '/app/$(evil)')
      expect(result.success).toBe(false)
    })
  })

  describe('executeReplace', () => {
    it('should backup and replace file on host', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })

      const pending = {
        machineId: 'prod',
        filePath: '/app/config.py',
        messageId: 'msg-1',
        createdAt: Date.now(),
      }

      const result = await commands.executeReplace(pending, 'new content here')
      expect(result.success).toBe(true)
      expect(result.output).toContain('replaced successfully')
      expect(result.output).toContain('Backup saved')

      // Verify backup was created
      expect(mockSsh.execRemote).toHaveBeenCalledWith(
        expect.any(Object),
        expect.arrayContaining(['mkdir', '-p', '/tmp/.remote-cli-backups']),
      )
      expect(mockSsh.execRemote).toHaveBeenCalledWith(
        expect.any(Object),
        expect.arrayContaining(['cp', '/app/config.py']),
      )
      expect(mockSsh.writeRemoteFile).toHaveBeenCalledWith(
        expect.any(Object), '/app/config.py', 'new content here'
      )

      // Verify backup record
      const backups = await backupStore.findByMachine('prod')
      expect(backups).toHaveLength(1)
      expect(backups[0].originalPath).toBe('/app/config.py')
    })

    it('should handle replace failure', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })
      mockSsh.writeRemoteFile.mockRejectedValue(new Error('Permission denied'))

      const pending = {
        machineId: 'prod',
        filePath: '/app/config.py',
        messageId: 'msg-1',
        createdAt: Date.now(),
      }

      const result = await commands.executeReplace(pending, 'content')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Permission denied')
    })
  })

  describe('listBackups', () => {
    it('should list backups for a machine', async () => {
      await backupStore.add({
        id: 'bk-1',
        machineId: 'prod',
        originalPath: '/app/config.py',
        backupPath: '/tmp/.remote-cli-backups/config.py.20260318T120000.bak',
        createdAt: Date.now(),
      })

      const result = await commands.listBackups('prod')
      expect(result.success).toBe(true)
      expect(result.output).toContain('/app/config.py')
      expect(result.output).toContain('config.py.20260318T120000.bak')
    })

    it('should filter by file path', async () => {
      await backupStore.add({
        id: 'bk-1',
        machineId: 'prod',
        originalPath: '/app/config.py',
        backupPath: '/tmp/.remote-cli-backups/config.py.bak',
        createdAt: Date.now(),
      })
      await backupStore.add({
        id: 'bk-2',
        machineId: 'prod',
        originalPath: '/app/main.py',
        backupPath: '/tmp/.remote-cli-backups/main.py.bak',
        createdAt: Date.now(),
      })

      const result = await commands.listBackups('prod', '/app/config.py')
      expect(result.success).toBe(true)
      expect(result.output).toContain('config.py')
      expect(result.output).not.toContain('main.py')
    })

    it('should handle no backups', async () => {
      const result = await commands.listBackups('prod')
      expect(result.success).toBe(true)
      expect(result.output).toContain('No backups found')
    })
  })

  describe('restoreBackup', () => {
    it('should restore file on host', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })

      const result = await commands.restoreBackup(
        'prod',
        '/tmp/.remote-cli-backups/config.py.bak',
        '/app/config.py'
      )

      expect(result.success).toBe(true)
      expect(result.output).toContain('Restored')
      expect(mockSsh.execRemote).toHaveBeenCalledWith(
        expect.any(Object),
        ['cp', '/tmp/.remote-cli-backups/config.py.bak', '/app/config.py'],
      )
    })

    it('should restore into container', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })

      const result = await commands.restoreBackup(
        'prod',
        '/tmp/.remote-cli-backups/config.py.bak',
        '/app/config.py',
        'abc123'
      )

      expect(result.success).toBe(true)
      expect(result.output).toContain('container')
      expect(mockSsh.execRemote).toHaveBeenCalledWith(
        expect.any(Object),
        expect.arrayContaining(['docker', 'cp']),
      )
    })

    it('should handle restore failure', async () => {
      await config.set('machines.prod', {
        user: 'admin', password: 'pass', port: 22,
      })
      mockSsh.execRemote.mockRejectedValue(new Error('File not found'))

      const result = await commands.restoreBackup('prod', '/tmp/missing.bak', '/app/config.py')
      expect(result.success).toBe(false)
      expect(result.error).toContain('File not found')
    })
  })
})
