import { z } from 'zod'
import { isIPv6 } from 'net'

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
const DestinationSchema = z.string().refine(value =>
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value) || isIPv6(value), 'Enter an SSH hostname, IP address or config alias')
const UserSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.@\\-]*\$?$/, 'Enter an SSH login name')

export const MachineConfigSchema = z.object({
  destination: DestinationSchema,
  user: UserSchema,
  password: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
})

export type MachineConfig = z.infer<typeof MachineConfigSchema>
export type ResolvedMachine = Omit<MachineConfig, 'destination'> & { host: string }

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
export const MachineAddArgsSchema = MachineConfigSchema.extend({ id: SafeIdSchema })

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
