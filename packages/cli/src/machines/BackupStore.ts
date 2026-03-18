import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import type { BackupRecord } from './types'

const BACKUP_FILE = 'backups.json'

/**
 * Manages backup records persistence
 * Stores records in ~/.remote-cli/backups.json
 */
export class BackupStore {
  private filePath: string

  constructor(configDir?: string) {
    const dir = configDir || path.join(os.homedir(), '.remote-cli')
    this.filePath = path.join(dir, BACKUP_FILE)
  }

  /**
   * Load all backup records from disk
   */
  async loadAll(): Promise<BackupRecord[]> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8')
      const records = JSON.parse(content)
      return Array.isArray(records) ? records : []
    } catch {
      return []
    }
  }

  /**
   * Save all backup records to disk
   */
  private async saveAll(records: BackupRecord[]): Promise<void> {
    const dir = path.dirname(this.filePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(records, null, 2), 'utf-8')
  }

  /**
   * Add a new backup record
   */
  async add(record: BackupRecord): Promise<void> {
    const records = await this.loadAll()
    return this.saveAll([...records, record])
  }

  /**
   * Find backups by machine ID and optional file path
   */
  async findByMachine(machineId: string, filePath?: string): Promise<BackupRecord[]> {
    const records = await this.loadAll()
    return records.filter((r) => {
      if (r.machineId !== machineId) return false
      if (filePath && r.originalPath !== filePath) return false
      return true
    })
  }

  /**
   * Find a specific backup by ID
   */
  async findById(id: string): Promise<BackupRecord | undefined> {
    const records = await this.loadAll()
    return records.find((r) => r.id === id)
  }

  /**
   * Remove a backup record by ID
   */
  async remove(id: string): Promise<boolean> {
    const records = await this.loadAll()
    const filtered = records.filter((r) => r.id !== id)
    if (filtered.length === records.length) return false
    await this.saveAll(filtered)
    return true
  }

  /**
   * Generate a backup path from the original file path
   */
  static generateBackupPath(originalPath: string): string {
    const basename = path.basename(originalPath)
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return `/tmp/.remote-cli-backups/${basename}.${timestamp}.bak`
  }
}
