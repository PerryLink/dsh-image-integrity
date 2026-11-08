/**
 * Config schema and resolution for `dsh-image-integrity`.
 * @module dsh-image-integrity/config
 */

import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Raw plugin config. */
export interface Config {
  enabled?: boolean
  root?: string
  workspaceRoot?: string
  maxBytes?: number
  maxPixels?: number
  persist?: boolean
  blockSize?: number
  maxShiftBits?: number
  minVariance?: number
  nccThreshold?: number
}

/** Fully resolved config. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly root: string
  readonly workspaceRoot: string
  readonly maxBytes: number
  readonly maxPixels: number
  readonly persist: boolean
  readonly blockSize: number
  readonly maxShiftBits: number
  readonly minVariance: number
  readonly nccThreshold: number
}

/** Schemastery schema. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  root: z.string().default('.image-integrity'),
  workspaceRoot: z.string(),
  maxBytes: z.number().default(20 * 1024 * 1024),
  maxPixels: z.number().default(4_000_000),
  persist: z.boolean().default(true),
  blockSize: z.number().default(16),
  maxShiftBits: z.number().default(6),
  minVariance: z.number().default(6),
  nccThreshold: z.number().default(0.97),
})

/** Throw unless the value is a positive safe integer. */
function assertPositiveInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer, got ${String(value)}`)
}

/**
 * Validate raw values and fill explicit defaults.
 * @param config - raw plugin config.
 * @returns the fully resolved config.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const root = config.root ?? '.image-integrity'
  if (typeof root !== 'string' || root.trim() === '') throw new TypeError('root must be a non-empty path')
  const maxBytes = config.maxBytes ?? 20 * 1024 * 1024
  const maxPixels = config.maxPixels ?? 4_000_000
  const blockSize = config.blockSize ?? 16
  for (const [name, value] of Object.entries({ maxBytes, maxPixels, blockSize })) assertPositiveInt(name, value)
  const maxShiftBits = config.maxShiftBits ?? 6
  const minVariance = config.minVariance ?? 6
  const nccThreshold = config.nccThreshold ?? 0.97
  for (const [name, value] of Object.entries({ maxShiftBits, minVariance })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  if (!(nccThreshold >= 0 && nccThreshold <= 1)) throw new TypeError('nccThreshold must be between 0 and 1')
  return {
    enabled: config.enabled ?? true,
    root: path.resolve(root),
    workspaceRoot: path.resolve(config.workspaceRoot ?? process.cwd()),
    maxBytes,
    maxPixels,
    persist: config.persist ?? true,
    blockSize,
    maxShiftBits,
    minVariance,
    nccThreshold,
  }
}
