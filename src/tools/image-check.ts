/**
 * `image_check` — duplicate and mirrored regions inside one image.
 * @module dsh-image-integrity/tools/image-check
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
 * Build the `image_check` tool.
 * @param runtime - the runtime.
 * @returns the tool definition.
 */
export function makeImageCheckTool(runtime: ImageRuntime) {
  return defineTool({
    name: 'image_check',
    description: [
      'Find duplicated or mirrored regions inside one image (dsh-image-integrity).',
      '',
      'Decodes 8-bit non-interlaced PNG (grey/RGB/RGBA) with zero dependencies, reduces blocks to mean-threshold bit patterns, ignores flat blocks, and reports matched regions with NCC confirmation. Useful for spotting a panel reused twice or pasted mirrored.',
      '',
      'This finds reused pixels, not manipulation intent: repeated controls, scale bars and icons are legitimate. JPEG is not decoded (documented limitation).',
    ].join('\n'),
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative PNG path.' },
      persist: { type: 'boolean', description: 'Store the image as REP evidence + record (default true).' },
      blockSize: { type: 'integer', description: 'Block side in pixels (default 16).' },
      maxShiftBits: { type: 'integer', description: 'Bit-pattern tolerance (default 6 of 256).' },
      minVariance: { type: 'number', description: 'Ignore flatter blocks (default 6).' },
      nccThreshold: { type: 'number', description: 'NCC confirmation threshold (default 0.97).' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as { ok: true; analysis: { duplicatePairs: number; flippedPairs: number; matches: unknown[] } } | { ok: false; error: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `image_check failed (${result.error.code}): ${result.error.message}` }]
        return [{ type: 'text', text: `image_check: ${result.analysis.duplicatePairs} duplicate region(s), ${result.analysis.flippedPairs} mirrored region(s)` }]
      },
    },
    async execute(args: unknown) {
      const request = args as { path?: string; persist?: boolean; blockSize?: number; maxShiftBits?: number; minVariance?: number; nccThreshold?: number }
      try {
        const result = await runtime.check({
          ...(request.path === undefined ? {} : { path: request.path }),
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
