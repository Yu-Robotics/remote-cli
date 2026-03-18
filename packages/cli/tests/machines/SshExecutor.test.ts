import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SshExecutor } from '../../src/machines/SshExecutor'
import type { ResolvedMachine } from '../../src/machines/types'
import { EventEmitter } from 'events'

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'child_process'

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>

function createMockProcess(
  exitCode = 0,
  stdout = '',
  stderr = '',
  resolveOnStdinEnd = false
) {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()

  const doResolve = () => {
    setImmediate(() => {
      if (stdout) {
        proc.stdout.emit('data', Buffer.from(stdout))
      }
      if (stderr) {
        proc.stderr.emit('data', Buffer.from(stderr))
      }
      proc.emit('close', exitCode)
    })
  }

  proc.stdin = {
    write: vi.fn(),
    end: vi.fn(() => {
      if (resolveOnStdinEnd) {
        doResolve()
      }
    }),
  }

  if (!resolveOnStdinEnd) {
    doResolve()
  }

  return proc
}

describe('SshExecutor', () => {
  let executor: SshExecutor

  const passwordMachine: ResolvedMachine = {
    host: '192.168.1.100',
    user: 'deploy',
    password: 'secret123',
    port: 22,
  }

  const proxyMachine: ResolvedMachine = {
    host: 'a1-9.frp.xiaoyu.ai',
    user: 'nvidia',
    port: 22,
    proxy: {
      host: 'frps.xiaoyubot.com',
      port: 5002,
      auth: 'xiaoyu:IXa7s06Mo5',
    },
  }

  const proxyPasswordMachine: ResolvedMachine = {
    host: 'a1-37.frp.xiaoyu.ai',
    user: 'nvidia',
    password: 'gpupass',
    port: 22,
    proxy: {
      host: 'frps.xiaoyubot.com',
      port: 5002,
      auth: 'xiaoyu:IXa7s06Mo5',
    },
  }

  const keyMachine: ResolvedMachine = {
    host: '10.0.0.1',
    user: 'admin',
    port: 22,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    executor = new SshExecutor()
  })

  describe('execRemote', () => {
    it('should use sshpass for password-based auth', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0, 'hello world\n'))

      const result = await executor.execRemote(passwordMachine, ['echo', 'hello'])

      expect(mockSpawn).toHaveBeenCalledWith(
        'sshpass',
        [
          '-p', 'secret123',
          'ssh',
          '-p', '22',
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'UserKnownHostsFile=/dev/null',
          '-o', 'LogLevel=ERROR',
          '-o', 'ConnectTimeout=10',
          'deploy@192.168.1.100',
          'echo hello',
        ],
        expect.objectContaining({ timeout: 30_000 })
      )
      expect(result).toBe('hello world\n')
    })

    it('should use ProxyCommand for proxy-based key auth', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0, 'proxy output\n'))

      const result = await executor.execRemote(proxyMachine, ['ls', '/app'])

      expect(mockSpawn.mock.calls[0][0]).toBe('ssh')
      const args = mockSpawn.mock.calls[0][1]
      const proxyArg = args.find((a: string) => a.includes('ProxyCommand'))
      expect(proxyArg).toContain('PROXY:frps.xiaoyubot.com')
      expect(proxyArg).toContain('proxyport=5002')
      expect(proxyArg).toContain('proxyauth=xiaoyu:IXa7s06Mo5')
      expect(args).toContain('nvidia@a1-9.frp.xiaoyu.ai')
      expect(args).toContain('BatchMode=yes')
      const remoteCmd = args[args.length - 1]
      expect(remoteCmd).toBe('ls /app')
      expect(result).toBe('proxy output\n')
    })

    it('should use sshpass with ProxyCommand for proxy + password auth', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0, 'proxy pass output\n'))

      const result = await executor.execRemote(proxyPasswordMachine, ['ls', '/app'])

      expect(mockSpawn.mock.calls[0][0]).toBe('sshpass')
      const args = mockSpawn.mock.calls[0][1]
      expect(args[0]).toBe('-p')
      expect(args[1]).toBe('gpupass')
      expect(args[2]).toBe('ssh')
      const proxyArg = args.find((a: string) => a.includes('ProxyCommand'))
      expect(proxyArg).toContain('PROXY:frps.xiaoyubot.com')
      expect(args).toContain('nvidia@a1-37.frp.xiaoyu.ai')
      expect(args.find((a: string) => a.includes('BatchMode'))).toBeUndefined()
      const remoteCmd = args[args.length - 1]
      expect(remoteCmd).toBe('ls /app')
      expect(result).toBe('proxy pass output\n')
    })

    it('should use plain ssh for key-based auth', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0, 'key output\n'))

      await executor.execRemote(keyMachine, ['whoami'])

      expect(mockSpawn.mock.calls[0][0]).toBe('ssh')
      const args = mockSpawn.mock.calls[0][1]
      expect(args).toContain('admin@10.0.0.1')
      expect(args.find((a: string) => a.includes('ProxyCommand'))).toBeUndefined()
      expect(args[args.length - 1]).toBe('whoami')
    })

    it('should use custom port', async () => {
      const m = { ...passwordMachine, port: 2222 }
      mockSpawn.mockReturnValue(createMockProcess(0, 'ok'))

      await executor.execRemote(m, ['ls'])

      const args = mockSpawn.mock.calls[0][1]
      expect(args).toContain('2222')
    })

    it('should reject on non-zero exit code', async () => {
      mockSpawn.mockReturnValue(createMockProcess(1, '', 'No such file'))

      await expect(executor.execRemote(passwordMachine, ['cat', '/missing']))
        .rejects.toThrow('Command exited with code 1: No such file')
    })

    it('should detect authentication failure (exit code 5)', async () => {
      mockSpawn.mockReturnValue(createMockProcess(5))

      await expect(executor.execRemote(passwordMachine, ['ls']))
        .rejects.toThrow('SSH authentication failed: incorrect password')
    })

    it('should reject on spawn error', async () => {
      const proc = new EventEmitter() as any
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.stdin = { write: vi.fn(), end: vi.fn() }

      mockSpawn.mockReturnValue(proc)

      const promise = executor.execRemote(passwordMachine, ['ls'])
      process.nextTick(() => proc.emit('error', new Error('sshpass not found')))

      await expect(promise).rejects.toThrow('SSH command failed: sshpass not found')
    })

    it('should respect custom timeout', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0, 'ok'))

      await executor.execRemote(passwordMachine, ['ls'], 5000)

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ timeout: 5000 })
      )
    })
  })

  describe('readRemoteFile', () => {
    it('should use cat for full file read', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0, 'file content'))

      const result = await executor.readRemoteFile(proxyMachine, '/app/config.py')

      const args = mockSpawn.mock.calls[0][1]
      const remoteCmd = args[args.length - 1]
      expect(remoteCmd).toContain('cat')
      expect(remoteCmd).toContain('/app/config.py')
      expect(result).toBe('file content')
    })

    it('should use head for limited line read', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0, 'line1\nline2\n'))

      await executor.readRemoteFile(proxyMachine, '/app/config.py', 50)

      const args = mockSpawn.mock.calls[0][1]
      const remoteCmd = args[args.length - 1]
      expect(remoteCmd).toContain('head')
      expect(remoteCmd).toContain('-n')
      expect(remoteCmd).toContain('50')
    })
  })

  describe('writeRemoteFile', () => {
    it('should pipe content via stdin', async () => {
      const proc = createMockProcess(0, '', '', true)
      mockSpawn.mockReturnValue(proc)

      await executor.writeRemoteFile(proxyMachine, '/tmp/test.txt', 'new content')

      const args = mockSpawn.mock.calls[0][1]
      const remoteCmd = args[args.length - 1]
      expect(remoteCmd).toContain('tee')
      expect(remoteCmd).toContain('/tmp/test.txt')
      expect(proc.stdin.write).toHaveBeenCalledWith('new content')
      expect(proc.stdin.end).toHaveBeenCalled()
    })
  })

  describe('execInContainer', () => {
    it('should wrap command with docker exec', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0, 'container output'))

      const result = await executor.execInContainer(
        proxyMachine, 'abc123', ['ls', '/app']
      )

      const args = mockSpawn.mock.calls[0][1]
      const remoteCmd = args[args.length - 1]
      expect(remoteCmd).toContain('docker exec abc123')
      expect(remoteCmd).toContain('ls /app')
      expect(result).toBe('container output')
    })
  })

  describe('readContainerFile', () => {
    it('should read file from container via docker exec cat', async () => {
      mockSpawn.mockReturnValue(createMockProcess(0, 'container file'))

      const result = await executor.readContainerFile(
        proxyMachine, 'abc123', '/app/config.py'
      )

      const args = mockSpawn.mock.calls[0][1]
      const remoteCmd = args[args.length - 1]
      expect(remoteCmd).toContain('docker exec abc123')
      expect(remoteCmd).toContain('cat /app/config.py')
      expect(result).toBe('container file')
    })
  })

  describe('writeContainerFile', () => {
    it('should write to host temp then docker cp into container', async () => {
      let callCount = 0
      mockSpawn.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return createMockProcess(0, '', '', true)
        }
        return createMockProcess(0)
      })

      await executor.writeContainerFile(
        proxyMachine, 'abc123', '/app/config.py', 'new content'
      )

      expect(mockSpawn).toHaveBeenCalledTimes(3)

      const cpCmd = mockSpawn.mock.calls[1][1].at(-1)
      expect(cpCmd).toContain('docker cp')

      const rmCmd = mockSpawn.mock.calls[2][1].at(-1)
      expect(rmCmd).toContain('rm')
    })

    it('should cleanup temp file even if docker cp fails', async () => {
      let callCount = 0
      mockSpawn.mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return createMockProcess(0, '', '', true)
        }
        if (callCount === 2) {
          return createMockProcess(1, '', 'cp failed')
        }
        return createMockProcess(0)
      })

      await expect(
        executor.writeContainerFile(proxyMachine, 'abc123', '/app/f.py', 'content')
      ).rejects.toThrow('Command exited with code 1')

      expect(mockSpawn).toHaveBeenCalledTimes(3)
    })
  })
})
