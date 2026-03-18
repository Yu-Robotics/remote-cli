import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { BackupStore } from '../../src/machines/BackupStore'
import type { BackupRecord } from '../../src/machines/types'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

describe('BackupStore', () => {
  let store: BackupStore
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-store-test-'))
    store = new BackupStore(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const record1: BackupRecord = {
    id: 'bk-001',
    machineId: 'prod',
    originalPath: '/app/config.py',
    backupPath: '/tmp/.remote-cli-backups/config.py.20260318T120000.bak',
    createdAt: Date.now(),
  }

  const record2: BackupRecord = {
    id: 'bk-002',
    machineId: 'prod',
    originalPath: '/app/main.py',
    backupPath: '/tmp/.remote-cli-backups/main.py.20260318T120100.bak',
    createdAt: Date.now(),
  }

  const record3: BackupRecord = {
    id: 'bk-003',
    machineId: 'staging',
    originalPath: '/app/config.py',
    backupPath: '/tmp/.remote-cli-backups/config.py.20260318T120200.bak',
    containerId: 'abc123',
    createdAt: Date.now(),
  }

  describe('loadAll', () => {
    it('should return empty array when no file exists', async () => {
      const records = await store.loadAll()
      expect(records).toEqual([])
    })

    it('should return empty array for invalid JSON', async () => {
      await fs.writeFile(path.join(tmpDir, 'backups.json'), 'not json')
      const records = await store.loadAll()
      expect(records).toEqual([])
    })
  })

  describe('add', () => {
    it('should add a record and persist to disk', async () => {
      await store.add(record1)

      const records = await store.loadAll()
      expect(records).toHaveLength(1)
      expect(records[0]).toEqual(record1)
    })

    it('should append to existing records', async () => {
      await store.add(record1)
      await store.add(record2)

      const records = await store.loadAll()
      expect(records).toHaveLength(2)
    })
  })

  describe('findByMachine', () => {
    it('should filter by machineId', async () => {
      await store.add(record1)
      await store.add(record2)
      await store.add(record3)

      const results = await store.findByMachine('prod')
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.machineId === 'prod')).toBe(true)
    })

    it('should filter by machineId and filePath', async () => {
      await store.add(record1)
      await store.add(record2)

      const results = await store.findByMachine('prod', '/app/config.py')
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('bk-001')
    })

    it('should return empty for unknown machine', async () => {
      await store.add(record1)

      const results = await store.findByMachine('unknown')
      expect(results).toHaveLength(0)
    })
  })

  describe('findById', () => {
    it('should find a record by id', async () => {
      await store.add(record1)
      await store.add(record2)

      const result = await store.findById('bk-001')
      expect(result).toEqual(record1)
    })

    it('should return undefined for unknown id', async () => {
      await store.add(record1)

      const result = await store.findById('bk-999')
      expect(result).toBeUndefined()
    })
  })

  describe('remove', () => {
    it('should remove a record by id', async () => {
      await store.add(record1)
      await store.add(record2)

      const removed = await store.remove('bk-001')
      expect(removed).toBe(true)

      const records = await store.loadAll()
      expect(records).toHaveLength(1)
      expect(records[0].id).toBe('bk-002')
    })

    it('should return false when id not found', async () => {
      await store.add(record1)

      const removed = await store.remove('bk-999')
      expect(removed).toBe(false)
    })
  })

  describe('generateBackupPath', () => {
    it('should generate path with timestamp and .bak extension', () => {
      const bkPath = BackupStore.generateBackupPath('/app/config.py')

      expect(bkPath).toMatch(/^\/tmp\/\.remote-cli-backups\/config\.py\.\d{8}T\d{6}\.bak$/)
    })

    it('should use basename of the original path', () => {
      const bkPath = BackupStore.generateBackupPath('/very/deep/nested/file.txt')

      expect(bkPath).toContain('file.txt.')
    })
  })
})
