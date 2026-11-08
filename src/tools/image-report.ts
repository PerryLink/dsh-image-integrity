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
      const request = args as { analysis?: ImageAnalysis & Partial<PairAnalysis>; imageId?: string }
      const analysis = request.analysis
      if (analysis === undefined) return { ok: false as const, error: { code: 'INVALID_INPUT', message: 'pass the analysis object from image_check or image_compare' } }
      const isPair = 'a' in analysis && 'b' in analysis
      const markdown = isPair ? renderPairMarkdown(analysis as PairAnalysis) : renderImageMarkdown(analysis, request.imageId)
      return { ok: true as const, markdown, sarif: renderSarif(analysis, VERSION) as never }
    },
  })
}
