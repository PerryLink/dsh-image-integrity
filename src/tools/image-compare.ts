/**
 * `image_compare` — shared duplicated or mirrored regions between two images.
 * @module dsh-image-integrity/tools/image-compare
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { ImageError, type ImageRuntime } from '../runtime.ts'
import { ERROR_SCHEMA } from './shared.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    analysis: { type: 'json' },
    evidenceId: { type: 'string' },
    recordPath: { type: 'string' },
    error: ERROR_SCHEMA,
  },
} as const

/**
 * Build the `image_compare` tool.
 * @param runtime - the runtime.
 * @returns the tool definition.
 */
export function makeImageCompareTool(runtime: ImageRuntime) {
  return defineTool({
    name: 'image_compare',
    description: [
      'Compare two images block by block and report shared duplicated or mirrored regions (dsh-image-integrity).',
      '',
      'Both images must have identical dimensions — no resize or alignment is attempted, so a dimension mismatch is reported rather than guessed. Shared blocks can be legitimate (same control, same background texture).',
    ].join('\n'),
    parameters: {
      pathA: { type: 'string', required: true, description: 'Workspace-relative PNG path (A).' },
      pathB: { type: 'string', required: true, description: 'Workspace-relative PNG path (B).' },
      persist: { type: 'boolean', description: 'Store both images as REP evidence + record (default true).' },
      blockSize: { type: 'integer', description: 'Block side in pixels (default 16).' },
      maxShiftBits: { type: 'integer', description: 'Bit-pattern tolerance (default 6 of 256).' },
      minVariance: { type: 'number', description: 'Ignore flatter blocks (default 6).' },
      nccThreshold: { type: 'number', description: 'NCC confirmation threshold (default 0.97).' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as { ok: true; analysis: { duplicatePairs: number; flippedPairs: number; warnings: string[] } } | { ok: false; error: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `image_compare failed (${result.error.code}): ${result.error.message}` }]
        return [{ type: 'text', text: `image_compare: ${result.analysis.duplicatePairs} shared duplicate region(s), ${result.analysis.flippedPairs} shared mirrored region(s)` }]
      },
    },
    async execute(args: unknown) {
      const request = args as { pathA?: string; pathB?: string; persist?: boolean; blockSize?: number; maxShiftBits?: number; minVariance?: number; nccThreshold?: number }
      try {
        const result = await runtime.compare({
          ...(request.pathA === undefined ? {} : { pathA: request.pathA }),
          ...(request.pathB === undefined ? {} : { pathB: request.pathB }),
          ...(request.persist === undefined ? {} : { persist: request.persist }),
          options: {
            ...(request.blockSize === undefined ? {} : { blockSize: request.blockSize }),
            ...(request.maxShiftBits === undefined ? {} : { maxShiftBits: request.maxShiftBits }),
            ...(request.minVariance === undefined ? {} : { minVariance: request.minVariance }),
            ...(request.nccThreshold === undefined ? {} : { nccThreshold: request.nccThreshold }),
          },
        })
        return {
          ok: true as const,
          analysis: result.analysis as never,
          ...(result.evidenceId === undefined ? {} : { evidenceId: result.evidenceId }),
          ...(result.recordPath === undefined ? {} : { recordPath: result.recordPath }),
        }
      } catch (error) {
        if (error instanceof ImageError) return { ok: false as const, error: { code: error.code, message: error.message } }
        throw error
      }
    },
  })
}
