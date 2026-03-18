import { z } from 'zod'

/**
 * Safe path pattern - rejects shell injection characters
 */
const safePathPattern = /^[a-zA-Z0-9_\-./~]+$/

const SafePathSchema = z.string().min(1).regex(safePathPattern, {
  message: 'Path contains unsafe characters (no ;, &, |, $, `, (, ) allowed)',
})

const SafeIdSchema = z.string().min(1).regex(/^[a-zA-Z0-9_\-.]+$/, {
  message: 'ID must contain only alphanumeric, underscore, dash, or dot characters',
})

/**
 * Machine configuration schema (per-machine, simple)
 */
export const MachineConfigSchema = z.object({
  user: z.string().min(1),
  password: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(22),
})

/**
 * Machine configuration interface
 */
export interface MachineConfig {
  user: string
  password?: string
  port: number
}

/**
 */
export interface ResolvedMachine {
  host: string
  user: string
  password?: string
  port: number
}

/**
 * Backup record
 */
export interface BackupRecord {
  id: string
  machineId: string
  originalPath: string
  backupPath: string
  containerId?: string
  createdAt: number
}

/**
 * Pending replace state
 */
export interface PendingReplace {
  machineId: string
  filePath: string
  containerId?: string
  messageId: string
  openId?: string
  createdAt: number
}

/**
 * Command argument schemas for validation
 */
export const MachineAddArgsSchema = z.object({
  id: SafeIdSchema,
  user: z.string().min(1),
  password: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(22),
})

export const SearchArgsSchema = z.object({
  machineId: SafeIdSchema,
  path: SafePathSchema,
  pattern: z.string().min(1),
  containerId: SafeIdSchema.optional(),
})

export const ViewArgsSchema = z.object({
  machineId: SafeIdSchema,
  filePath: SafePathSchema,
  containerId: SafeIdSchema.optional(),
  lines: z.number().int().min(1).max(500).default(100),
})

export const ReplaceArgsSchema = z.object({
  machineId: SafeIdSchema,
  filePath: SafePathSchema,
  containerId: SafeIdSchema.optional(),
})

export const RestoreArgsSchema = z.object({
  machineId: SafeIdSchema,
  backupPath: SafePathSchema,
  targetPath: SafePathSchema,
  containerId: SafeIdSchema.optional(),
})

export const ContainersArgsSchema = z.object({
  machineId: SafeIdSchema,
})

export const BackupsArgsSchema = z.object({
  machineId: SafeIdSchema,
  filePath: SafePathSchema.optional(),
})
