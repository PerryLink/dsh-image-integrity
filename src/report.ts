/**
 * Markdown and SARIF rendering for image integrity reports.
 * @module dsh-image-integrity/report
 */

import type { ImageAnalysis, PairAnalysis } from './analyze.ts'

/** Render one image analysis as Markdown. */
export function renderImageMarkdown(analysis: ImageAnalysis, imageId?: string): string {
  const lines = ['# Image integrity check', '']
  lines.push(`**Image:** ${imageId ?? 'inline'} · ${analysis.width}×${analysis.height} · block ${analysis.blockSize}px · ${analysis.considered}/${analysis.blocks} textured blocks`)
  lines.push('')
  lines.push(`**Duplicate regions:** ${analysis.duplicatePairs} · **mirrored regions:** ${analysis.flippedPairs}`)
  lines.push('')
  if (analysis.matches.length > 0) {
    lines.push('| Kind | Region A | Region B | NCC | Hamming |')
    lines.push('|---|---|---|---:|---:|')
    for (const match of analysis.matches) {
      lines.push(`| ${match.kind} | ${match.a.x},${match.a.y} | ${match.b.x},${match.b.y} | ${match.ncc} | ${match.hamming} |`)
    }
    lines.push('')
  }
  lines.push('## Notes')
  lines.push('')
  for (const warning of analysis.warnings) lines.push(`- ${warning}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

/** Render a pair comparison as Markdown. */
export function renderPairMarkdown(analysis: PairAnalysis, ids?: { a?: string; b?: string }): string {
  const lines = ['# Image pair comparison', '']
  lines.push(`**A:** ${ids?.a ?? 'inline'} (${analysis.a.width}×${analysis.a.height}) · **B:** ${ids?.b ?? 'inline'} (${analysis.b.width}×${analysis.b.height})`)
  lines.push('')
  lines.push(`**Shared duplicated regions:** ${analysis.duplicatePairs} · **shared mirrored regions:** ${analysis.flippedPairs}`)
  lines.push('')
  if (analysis.matches.length > 0) {
    lines.push('| Kind | Region A | Region B | NCC | Hamming |')
    lines.push('|---|---|---|---:|---:|')
    for (const match of analysis.matches) lines.push(`| ${match.kind} | ${match.a.x},${match.a.y} | ${match.b.x},${match.b.y} | ${match.ncc} | ${match.hamming} |`)
    lines.push('')
  }
  lines.push('## Notes')
  lines.push('')
  for (const warning of analysis.warnings) lines.push(`- ${warning}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

/** Render matches as SARIF 2.1.0. */
export function renderSarif(analysis: ImageAnalysis | PairAnalysis | undefined, version: string): Record<string, unknown> {
  const results = (analysis?.matches ?? []).map(match => ({
    ruleId: `image-integrity/${match.kind}`,
    level: 'warning' as const,
    message: { text: `${match.kind} region at (${match.a.x},${match.a.y}) and (${match.b.x},${match.b.y}); ncc=${match.ncc}, hamming=${match.hamming}` },
    properties: { kind: match.kind, a: match.a, b: match.b, hamming: match.hamming, ncc: match.ncc },
  }))
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'dsh-image-integrity', version } }, results }],
  }
}
