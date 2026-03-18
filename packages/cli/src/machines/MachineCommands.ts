import { ConfigManager } from '../config/ConfigManager'
import { SshExecutor } from './SshExecutor'
import { BackupStore } from './BackupStore'
import {
  SearchArgsSchema,
  ViewArgsSchema,
  ReplaceArgsSchema,
  RestoreArgsSchema,
  ContainersArgsSchema,
  BackupsArgsSchema,
  MachineAddArgsSchema,
  ProxyConfigSchema,
} from './types'
import type { MachineConfig, BackupRecord, PendingReplace, ResolvedMachine, RemoteConfig, ProxyConfig } from './types'

const MAX_SEARCH_RESULTS = 200
const DEFAULT_VIEW_LINES = 100

const DEFAULT_REMOTE: RemoteConfig = {
  proxy: {
    host: 'frps.xiaoyubot.com',
    port: 5002,
    auth: 'xiaoyu:IXa7s06Mo5',
  },
  hostSuffix: 'frp.xiaoyu.ai',
}

export interface CommandResult {
  success: boolean
  output?: string
  error?: string
}

/**
 * Machine command implementations
 * Host is derived from: <machineId>.<hostSuffix> (global config)
 * Proxy is applied globally from config.remote.proxy
 */
export class MachineCommands {
  private config: ConfigManager
  private ssh: SshExecutor
  private backupStore: BackupStore

  constructor(config: ConfigManager, ssh?: SshExecutor, backupStore?: BackupStore) {
    this.config = config
    this.ssh = ssh || new SshExecutor()
    this.backupStore = backupStore || new BackupStore(config.getConfigDir())
  }

  /**
   * Set global proxy configuration
   */
  async setProxy(
    proxyHost: string,
    proxyPort: number,
    hostSuffix: string,
    proxyAuth?: string
  ): Promise<CommandResult> {
    const parsed = ProxyConfigSchema.safeParse({ host: proxyHost, port: proxyPort, auth: proxyAuth })
    if (!parsed.success) {
      return { success: false, error: `Invalid proxy config: ${parsed.error.issues[0].message}` }
    }

    const remote: RemoteConfig = {
      proxy: { host: proxyHost, port: proxyPort, ...(proxyAuth ? { auth: proxyAuth } : {}) },
      hostSuffix,
    }
    await this.config.set('remote', remote)

    return {
      success: true,
      output: `Proxy configured: ${proxyHost}:${proxyPort}\nHost suffix: ${hostSuffix}`,
    }
  }

  /**
   * Show current proxy configuration
   */
  showProxy(): CommandResult {
    const userRemote = this.config.get('remote') as RemoteConfig | undefined
    const remote = this.getRemoteConfig()
    const isDefault = !userRemote?.proxy

    const lines = [
      `Proxy: ${remote.proxy!.host}:${remote.proxy!.port}${isDefault ? ' (default)' : ''}`,
      `Host suffix: ${remote.hostSuffix}`,
    ]
    if (remote.proxy!.auth) {
      lines.push(`Auth: ${'*'.repeat(remote.proxy!.auth.length)}`)
    }
    return { success: true, output: lines.join('\n') }
  }

  /**
   * List all configured machines
   */
  async listMachines(): Promise<CommandResult> {
    const machines = this.config.get('machines') as Record<string, MachineConfig> | undefined
    const remote = this.getRemoteConfig()

    if (!machines || Object.keys(machines).length === 0) {
      return { success: true, output: 'No machines configured. Use /machine add to add one.' }
    }

    const suffix = remote?.hostSuffix || ''
    const lines = Object.entries(machines).map(([id, m]) => {
      const host = suffix ? `${id}.${suffix}` : id
      return `${id} | ${host}:${m.port} | ${m.user}`
    })

    return {
      success: true,
      output: `Configured machines:\nID | Host | User\n${lines.join('\n')}`,
    }
  }

  /**
   * Add a machine configuration
   * Only needs id + user. Host is derived from id + global hostSuffix.
   */
  async addMachine(
    id: string,
    user: string,
    password?: string,
    port = 22
  ): Promise<CommandResult> {
    const parsed = MachineAddArgsSchema.safeParse({ id, user, password, port })
    if (!parsed.success) {
      return { success: false, error: `Invalid arguments: ${parsed.error.issues[0].message}` }
    }

    const machineConfig: MachineConfig = {
      user: parsed.data.user,
      port: parsed.data.port,
      ...(parsed.data.password ? { password: parsed.data.password } : {}),
    }

    await this.config.set(`machines.${id}`, machineConfig)

    const remote = this.getRemoteConfig()
    const host = remote.hostSuffix ? `${id}.${remote.hostSuffix}` : id

    return { success: true, output: `Machine "${id}" added: ${user}@${host}:${port}` }
  }

  /**
   * Remove a machine configuration
   */
  async removeMachine(id: string): Promise<CommandResult> {
    const machine = this.getRawMachine(id)
    if (!machine) {
      return { success: false, error: `Machine "${id}" not found` }
    }

    const machines = { ...(this.config.get('machines') as Record<string, MachineConfig>) }
    delete machines[id]
    await this.config.set('machines', machines)

    return { success: true, output: `Machine "${id}" removed` }
  }

  /**
   * Show a machine configuration (password masked)
   */
  showMachine(id: string): CommandResult {
    const machine = this.getRawMachine(id)
    if (!machine) {
      return { success: false, error: `Machine "${id}" not found` }
    }

    const resolved = this.resolveMachine(id, machine)
    const lines = [
      `Machine: ${id}`,
      `Host: ${resolved.host}`,
      `Port: ${resolved.port}`,
      `User: ${resolved.user}`,
    ]

    if (machine.password) {
      lines.push(`Password: ${'*'.repeat(machine.password.length)}`)
    }

    if (resolved.proxy) {
      lines.push(`Proxy: ${resolved.proxy.host}:${resolved.proxy.port} (global)`)
    } else {
      lines.push('Connection: direct')
    }

    return { success: true, output: lines.join('\n') }
  }

  /**
   * List Docker containers on a machine
   */
  async listContainers(machineId: string): Promise<CommandResult> {
    const parsed = ContainersArgsSchema.safeParse({ machineId })
    if (!parsed.success) {
      return { success: false, error: `Invalid arguments: ${parsed.error.issues[0].message}` }
    }

    const machine = this.getResolvedMachine(machineId)
    if (!machine) {
      return { success: false, error: `Machine "${machineId}" not found` }
    }

    try {
      const output = await this.ssh.execRemote(machine, [
        'docker', 'ps', '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}',
      ])

      if (!output.trim()) {
        return { success: true, output: 'No running containers found' }
      }

      return {
        success: true,
        output: `Containers on "${machineId}":\nID\tName\tStatus\tImage\n${output.trim()}`,
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to list containers: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /**
   * Search for files on a machine or in a container
   */
  async searchFiles(
    machineId: string,
    searchPath: string,
    pattern: string,
    containerId?: string
  ): Promise<CommandResult> {
    const parsed = SearchArgsSchema.safeParse({ machineId, path: searchPath, pattern, containerId })
    if (!parsed.success) {
      return { success: false, error: `Invalid arguments: ${parsed.error.issues[0].message}` }
    }

    const machine = this.getResolvedMachine(machineId)
    if (!machine) {
      return { success: false, error: `Machine "${machineId}" not found` }
    }

    const findArgs = ['find', searchPath, '-maxdepth', '10', '-name', pattern]

    try {
      const output = containerId
        ? await this.ssh.execInContainer(machine, containerId, findArgs)
        : await this.ssh.execRemote(machine, findArgs)

      const lines = output.trim().split('\n').filter(Boolean)
      const truncated = lines.length > MAX_SEARCH_RESULTS

      const resultLines = lines.slice(0, MAX_SEARCH_RESULTS)
      const header = containerId
        ? `Search results in container "${containerId}" on "${machineId}":`
        : `Search results on "${machineId}":`

      return {
        success: true,
        output: `${header}\n${resultLines.join('\n')}${truncated ? `\n... (${lines.length - MAX_SEARCH_RESULTS} more results truncated)` : ''}`,
      }
    } catch (error) {
      return {
        success: false,
        error: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /**
   * View a file on a machine or in a container
   */
  async viewFile(
    machineId: string,
    filePath: string,
    containerId?: string,
    lines = DEFAULT_VIEW_LINES
  ): Promise<CommandResult> {
    const parsed = ViewArgsSchema.safeParse({ machineId, filePath, containerId, lines })
    if (!parsed.success) {
      return { success: false, error: `Invalid arguments: ${parsed.error.issues[0].message}` }
    }

    const machine = this.getResolvedMachine(machineId)
    if (!machine) {
      return { success: false, error: `Machine "${machineId}" not found` }
    }

    try {
      const content = containerId
        ? await this.ssh.readContainerFile(machine, containerId, filePath, parsed.data.lines)
        : await this.ssh.readRemoteFile(machine, filePath, parsed.data.lines)

      const header = containerId
        ? `File: ${filePath} (container: ${containerId}, machine: ${machineId})`
        : `File: ${filePath} (machine: ${machineId})`

      const lang = this.detectLanguage(filePath)
      const body = lang
        ? `\`\`\`${lang}\n${content}\n\`\`\``
        : content

      return { success: true, output: `${header}\n---\n${body}` }
    } catch (error) {
      return {
        success: false,
        error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /**
   * Initiate a file replace (returns pending state info)
   */
  initiateReplace(
    machineId: string,
    filePath: string,
    containerId?: string
  ): CommandResult & { pending?: PendingReplace } {
    const parsed = ReplaceArgsSchema.safeParse({ machineId, filePath, containerId })
    if (!parsed.success) {
      return { success: false, error: `Invalid arguments: ${parsed.error.issues[0].message}` }
    }

    const machine = this.getResolvedMachine(machineId)
    if (!machine) {
      return { success: false, error: `Machine "${machineId}" not found` }
    }

    const pending: PendingReplace = {
      machineId,
      filePath,
      containerId,
      messageId: '',
      createdAt: Date.now(),
    }

    const target = containerId
      ? `${filePath} in container "${containerId}" on "${machineId}"`
      : `${filePath} on "${machineId}"`

    return {
      success: true,
      output: `Ready to replace ${target}.\nSend the new file content, or /cancel to abort.`,
      pending,
    }
  }

  /**
   * Execute a pending file replace with backup
   */
  async executeReplace(
    pending: PendingReplace,
    newContent: string
  ): Promise<CommandResult> {
    const machine = this.getResolvedMachine(pending.machineId)
    if (!machine) {
      return { success: false, error: `Machine "${pending.machineId}" not found` }
    }

    const backupPath = BackupStore.generateBackupPath(pending.filePath)

    try {
      // Create backup directory on remote
      await this.ssh.execRemote(machine, [
        'mkdir', '-p', '/tmp/.remote-cli-backups',
      ])

      if (pending.containerId) {
        // Container: backup from container to host, then write new
        await this.ssh.execRemote(machine, [
          'docker', 'cp', `${pending.containerId}:${pending.filePath}`, backupPath,
        ])
        await this.ssh.writeContainerFile(machine, pending.containerId, pending.filePath, newContent)
      } else {
        // Host: backup then write
        await this.ssh.execRemote(machine, [
          'cp', pending.filePath, backupPath,
        ])
        await this.ssh.writeRemoteFile(machine, pending.filePath, newContent)
      }

      // Record backup
      const record: BackupRecord = {
        id: `bk-${Date.now()}`,
        machineId: pending.machineId,
        originalPath: pending.filePath,
        backupPath,
        containerId: pending.containerId,
        createdAt: Date.now(),
      }
      await this.backupStore.add(record)

      return {
        success: true,
        output: `File replaced successfully.\nBackup saved at: ${backupPath}`,
      }
    } catch (error) {
      return {
        success: false,
        error: `Replace failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /**
   * List backups for a machine
   */
  async listBackups(machineId: string, filePath?: string): Promise<CommandResult> {
    const parsed = BackupsArgsSchema.safeParse({ machineId, filePath })
    if (!parsed.success) {
      return { success: false, error: `Invalid arguments: ${parsed.error.issues[0].message}` }
    }

    const records = await this.backupStore.findByMachine(machineId, filePath)

    if (records.length === 0) {
      return {
        success: true,
        output: filePath
          ? `No backups found for "${filePath}" on "${machineId}"`
          : `No backups found for machine "${machineId}"`,
      }
    }

    const lines = records.map((r) => {
      const date = new Date(r.createdAt).toISOString()
      const container = r.containerId ? ` (container: ${r.containerId})` : ''
      return `${r.originalPath} → ${r.backupPath}${container} [${date}]`
    })

    return {
      success: true,
      output: `Backups for "${machineId}":\n${lines.join('\n')}`,
    }
  }

  /**
   * Restore a file from backup
   */
  async restoreBackup(
    machineId: string,
    backupPath: string,
    targetPath: string,
    containerId?: string
  ): Promise<CommandResult> {
    const parsed = RestoreArgsSchema.safeParse({ machineId, backupPath, targetPath, containerId })
    if (!parsed.success) {
      return { success: false, error: `Invalid arguments: ${parsed.error.issues[0].message}` }
    }

    const machine = this.getResolvedMachine(machineId)
    if (!machine) {
      return { success: false, error: `Machine "${machineId}" not found` }
    }

    try {
      if (containerId) {
        await this.ssh.execRemote(machine, [
          'docker', 'cp', backupPath, `${containerId}:${targetPath}`,
        ])
      } else {
        await this.ssh.execRemote(machine, ['cp', backupPath, targetPath])
      }

      return {
        success: true,
        output: `Restored ${backupPath} → ${targetPath}${containerId ? ` (container: ${containerId})` : ''}`,
      }
    } catch (error) {
      return {
        success: false,
        error: `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /**
   * Get raw machine config (without host/proxy resolution)
   */
  private getRawMachine(id: string): MachineConfig | undefined {
    return this.config.get(`machines.${id}`) as MachineConfig | undefined
  }

  /**
   * Resolve a machine config: derive host from id + suffix, add global proxy
   */
  private resolveMachine(id: string, machine: MachineConfig): ResolvedMachine {
    const remote = this.getRemoteConfig()
    const host = remote.hostSuffix ? `${id}.${remote.hostSuffix}` : id

    return {
      host,
      user: machine.user,
      password: machine.password,
      port: machine.port,
      proxy: remote.proxy,
    }
  }

  /**
   * Get a fully resolved machine by ID (host + proxy filled in)
   */
  private getResolvedMachine(id: string): ResolvedMachine | undefined {
    const machine = this.getRawMachine(id)
    if (!machine) return undefined
    return this.resolveMachine(id, machine)
  }

  /**
   * Get remote config, falling back to built-in defaults
   */
  private getRemoteConfig(): RemoteConfig {
    const remote = this.config.get('remote') as RemoteConfig | undefined
    return remote || DEFAULT_REMOTE
  }

  /**
   * Detect programming language from file extension
   */
  private detectLanguage(filePath: string): string | null {
    const ext = filePath.split('.').pop()?.toLowerCase()
    const langMap: Record<string, string> = {
      py: 'python', js: 'javascript', ts: 'typescript', jsx: 'jsx', tsx: 'tsx',
      java: 'java', go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
      c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
      sh: 'bash', bash: 'bash', zsh: 'bash',
      yml: 'yaml', yaml: 'yaml', json: 'json', toml: 'toml', xml: 'xml',
      html: 'html', css: 'css', scss: 'scss', less: 'less',
      sql: 'sql', md: 'markdown', dockerfile: 'dockerfile',
      lua: 'lua', r: 'r', swift: 'swift', kt: 'kotlin',
      conf: 'ini', ini: 'ini', cfg: 'ini', env: 'bash',
    }
    if (!ext) {
      const name = filePath.split('/').pop()?.toLowerCase() || ''
      if (name === 'dockerfile') return 'dockerfile'
      if (name === 'makefile') return 'makefile'
      return null
    }
    return langMap[ext] || null
  }
}
