/**
 * `image_report` — Markdown + SARIF from an image analysis.
 * @module dsh-image-integrity/tools/image-report
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ImageAnalysis, PairAnalysis } from '../analyze.ts'
import { renderImageMarkdown, renderPairMarkdown, renderSarif } from '../report.ts'
import { VERSION } from '../version.ts'
import { ERROR_SCHEMA } from './shared.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    markdown: { type: 'string' },
    sarif: { type: 'json' },
    error: ERROR_SCHEMA,
  },
} as const

/** True when `value` is a non-null object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Validate the parts of a rendered match both renderers dereference. */
function isMatch(value: unknown): boolean {
  return isRecord(value)
    && typeof value['kind'] === 'string'
    && typeof value['ncc'] === 'number'
    && typeof value['hamming'] === 'number'
    && isRecord(value['a']) && typeof value['a']['x'] === 'number' && typeof value['a']['y'] === 'number'
    && isRecord(value['b']) && typeof value['b']['x'] === 'number' && typeof value['b']['y'] === 'number'
}

/**
 * Build the `image_report` tool.
 * @returns the tool definition.
 */
export function makeImageReportTool() {
  return defineTool({
    name: 'image_report',
    description: [
      'Render an image_check or image_compare result as Markdown + SARIF 2.1.0 (dsh-image-integrity).',
      '',
      'Every matched region becomes a SARIF warning with its coordinates and scores. The report repeats that reused pixels are not proof of manipulation.',
    ].join('\n'),
    parameters: {
      analysis: { type: 'json', required: true, description: 'The `analysis` object from image_check.' },
      imageId: { type: 'string', description: 'Image id for the heading.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as { ok: true; markdown: string } | { ok: false; error: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `image_report failed (${result.error.code}): ${result.error.message}` }]
        return [{ type: 'text', text: result.markdown }]
      },
    },
    async execute(args: unknown) {
      const request = args as { analysis?: unknown; imageId?: unknown }
      const analysis = request.analysis
      if (!isRecord(analysis) || !Array.isArray(analysis['matches']) || !Array.isArray(analysis['warnings'])
        || typeof analysis['duplicatePairs'] !== 'number' || typeof analysis['flippedPairs'] !== 'number') {
        return { ok: false as const, error: { code: 'INVALID_INPUT', message: 'pass the analysis object from image_check or image_compare' } }
      }
      if (!analysis['matches'].every(isMatch)) {
        return { ok: false as const, error: { code: 'INVALID_INPUT', message: 'analysis.matches contains a malformed region; pass the object returned by image_check/image_compare' } }
      }
      if (request.imageId !== undefined && typeof request.imageId !== 'string') {
        return { ok: false as const, error: { code: 'INVALID_INPUT', message: 'imageId must be a string' } }
      }
      const a = analysis['a']
      const b = analysis['b']
      const isPair = isRecord(a) && isRecord(b)
      if (isRecord(a) && isRecord(b)) {
        if (typeof a['width'] !== 'number' || typeof a['height'] !== 'number'
          || typeof b['width'] !== 'number' || typeof b['height'] !== 'number') {
          return { ok: false as const, error: { code: 'INVALID_INPUT', message: 'analysis.a/b must carry numeric width and height' } }
        }
      } else if (typeof analysis['width'] !== 'number' || typeof analysis['height'] !== 'number'
        || typeof analysis['blockSize'] !== 'number' || typeof analysis['considered'] !== 'number' || typeof analysis['blocks'] !== 'number') {
        return { ok: false as const, error: { code: 'INVALID_INPUT', message: 'analysis must be a single-image or pair analysis' } }
      }
      const markdown = isPair ? renderPairMarkdown(analysis as unknown as PairAnalysis) : renderImageMarkdown(analysis as unknown as ImageAnalysis, request.imageId)
      return { ok: true as const, markdown, sarif: renderSarif(analysis as unknown as ImageAnalysis, VERSION) as never }
    },
  })
}
