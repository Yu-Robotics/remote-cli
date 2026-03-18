import { spawn } from 'child_process'
import type { ResolvedMachine } from './types'

const DEFAULT_TIMEOUT = 30_000
const MAX_OUTPUT_SIZE = 1024 * 1024 // 1MB

/**
 * SSH command executor
 * Supports two modes:
 * - Proxy mode: ssh -o 'ProxyCommand socat ...' user@host (key-based auth via proxy)
 * - Password mode: sshpass -p <password> ssh user@host
 */
export class SshExecutor {
  /**
   * Build SSH command and args for a machine
   * Returns { command, args } where command is either 'ssh' (proxy) or 'sshpass' (password)
   */
  private buildSshCommand(machine: ResolvedMachine): { command: string; args: string[] } {
    const sshOptions = [
      '-p', String(machine.port),
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-o', 'ConnectTimeout=10',
    ]

    if (machine.proxy) {
      const proxyParts = [
        `PROXY:${machine.proxy.host}:%h:%p`,
        `proxyport=${machine.proxy.port}`,
      ]
      if (machine.proxy.auth) {
        proxyParts.push(`proxyauth=${machine.proxy.auth}`)
      }
      const proxyCommand = `socat - ${proxyParts.join(',')}`
      sshOptions.push('-o', `ProxyCommand=${proxyCommand}`)

      if (machine.password) {
        // Proxy + password: sshpass with ProxyCommand
        return {
          command: 'sshpass',
          args: ['-p', machine.password, 'ssh', ...sshOptions, `${machine.user}@${machine.host}`],
        }
      }

      // Proxy + key auth
      sshOptions.push('-o', 'BatchMode=yes')
      return {
        command: 'ssh',
        args: [...sshOptions, `${machine.user}@${machine.host}`],
      }
    }

    if (machine.password) {
      // Password mode: use sshpass (no BatchMode, sshpass handles password)
      return {
        command: 'sshpass',
        args: ['-p', machine.password, 'ssh', ...sshOptions, `${machine.user}@${machine.host}`],
      }
    }

    // Key-based auth (no password, no proxy)
    sshOptions.push('-o', 'BatchMode=yes')
    return {
      command: 'ssh',
      args: [...sshOptions, `${machine.user}@${machine.host}`],
    }
  }

  /**
   * Execute a command on a remote host
   */
  async execRemote(
    machine: ResolvedMachine,
    cmdArgs: string[],
    timeout = DEFAULT_TIMEOUT
  ): Promise<string> {
    const { command, args } = this.buildSshCommand(machine)
    const remoteCmd = this.shellQuote(cmdArgs)
    return this.spawnCommand(command, [...args, remoteCmd], timeout)
  }

  /**
   * Read a file from a remote host
   */
  async readRemoteFile(
    machine: ResolvedMachine,
    remotePath: string,
    maxLines?: number
  ): Promise<string> {
    const cmdArgs = maxLines
      ? ['head', '-n', String(maxLines), remotePath]
      : ['cat', remotePath]
    return this.execRemote(machine, cmdArgs)
  }

  /**
   * Write content to a remote file via stdin pipe
   */
  async writeRemoteFile(
    machine: ResolvedMachine,
    remotePath: string,
    content: string
  ): Promise<void> {
    const { command, args } = this.buildSshCommand(machine)
    const remoteCmd = this.shellQuote(['tee', remotePath])
    await this.spawnCommandWithStdin(command, [...args, remoteCmd], content)
  }

  /**
   * Execute a command inside a Docker container on a remote host
   */
  async execInContainer(
    machine: ResolvedMachine,
    containerId: string,
    cmdArgs: string[],
    timeout = DEFAULT_TIMEOUT
  ): Promise<string> {
    return this.execRemote(
      machine,
      ['docker', 'exec', containerId, ...cmdArgs],
      timeout
    )
  }

  /**
   * Read a file from a Docker container
   * Strategy: docker exec cat <path>
   */
  async readContainerFile(
    machine: ResolvedMachine,
    containerId: string,
    filePath: string,
    maxLines?: number
  ): Promise<string> {
    const cmdArgs = maxLines
      ? ['head', '-n', String(maxLines), filePath]
      : ['cat', filePath]
    return this.execInContainer(machine, containerId, cmdArgs)
  }

  /**
   * Write a file to a Docker container
   * Strategy: write to host temp → docker cp into container
   */
  async writeContainerFile(
    machine: ResolvedMachine,
    containerId: string,
    filePath: string,
    content: string
  ): Promise<void> {
    const tempPath = `/tmp/.remote-cli-tmp-${Date.now()}`
    try {
      await this.writeRemoteFile(machine, tempPath, content)
      await this.execRemote(machine, [
        'docker', 'cp', tempPath, `${containerId}:${filePath}`,
      ])
    } finally {
      await this.execRemote(machine, ['rm', '-f', tempPath]).catch(() => {})
    }
  }

  /**
   * Shell-quote args for safe execution through a remote shell.
   * Returns a single string where each arg is properly quoted.
   */
  private shellQuote(args: string[]): string {
    return args.map((a) => {
      if (/^[a-zA-Z0-9._\-/=:@%{}*]+$/.test(a)) return a
      return "'" + a.replace(/'/g, "'\\''" ) + "'"
    }).join(' ')
  }

  /**
   * Spawn a command and collect output
   */
  private spawnCommand(
    command: string,
    args: string[],
    timeout = DEFAULT_TIMEOUT
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let totalSize = 0

      child.stdout.on('data', (data: Buffer) => {
        totalSize += data.length
        if (totalSize <= MAX_OUTPUT_SIZE) {
          stdoutChunks.push(data)
        }
      })

      child.stderr.on('data', (data: Buffer) => {
        stderrChunks.push(data)
      })

      child.on('error', (error) => {
        reject(new Error(`SSH command failed: ${error.message}`))
      })

      child.on('close', (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8')
        const stderr = Buffer.concat(stderrChunks).toString('utf-8')

        if (code === 0) {
          resolve(stdout)
        } else if (code === 5) {
          reject(new Error('SSH authentication failed: incorrect password'))
        } else if (code === 255) {
          reject(new Error(
            `SSH connection failed: ${stderr.trim() || 'unable to connect (check if machine is online and SSH key is authorized)'}`
          ))
        } else {
          reject(new Error(
            `Command exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`
          ))
        }
      })
    })
  }

  /**
   * Spawn a command with stdin input
   */
  private spawnCommandWithStdin(
    command: string,
    args: string[],
    input: string,
    timeout = DEFAULT_TIMEOUT
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout,
      })

      const stderrChunks: Buffer[] = []

      child.stdout.on('data', () => {})

      child.stderr.on('data', (data: Buffer) => {
        stderrChunks.push(data)
      })

      child.on('error', (error) => {
        reject(new Error(`SSH command failed: ${error.message}`))
      })

      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          const stderr = Buffer.concat(stderrChunks).toString('utf-8')
          reject(new Error(
            `Command exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`
          ))
        }
      })

      child.stdin.write(input)
      child.stdin.end()
    })
  }
}
