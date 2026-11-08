/**
 * `dsh-image-integrity` — block-level image reuse detection for PNG figures.
 *
 * Three tools: image_check (one image), image_compare (two images),
 * image_report (Markdown + SARIF). Zero dependencies: PNG is decoded with
 * node:zlib. JPEG is not supported in v0.1 and says so.
 *
 * Function plugin — no default export.
 * @module dsh-image-integrity
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type Config as ConfigShape } from './config.ts'
import { ImageRuntime, type EvidencePort } from './runtime.ts'
import { makeImageCheckTool } from './tools/image-check.ts'
import { makeImageCompareTool } from './tools/image-compare.ts'
import { makeImageReportTool } from './tools/image-report.ts'

/** Cordis plugin name. */
export const name = 'image-integrity'

/** The tool registry is required; the REP service is optional. */
export const inject = ['tools']

export { Config, resolveConfig }
export type { ConfigShape }
export type { ResolvedConfig } from './config.ts'
export { VERSION } from './version.ts'
export { PngError, crc32, decodePng, encodeGreyPng } from './png.ts'
export type { DecodePngOptions, PngErrorCode, RgbaImage } from './png.ts'
export { analyzeImage, compareImages, hamming, ncc, resolveImageOptions, toGray } from './analyze.ts'
export type { ImageAnalysis, ImageOptions, PairAnalysis, RegionMatch } from './analyze.ts'
export { renderImageMarkdown, renderPairMarkdown, renderSarif } from './report.ts'
export { ImageError, ImageRuntime } from './runtime.ts'
export type { CheckResultValue, CompareResultValue, EvidencePort, ImageErrorCode, ImageRuntimeOptions, LoadedImage } from './runtime.ts'
export { makeImageCheckTool } from './tools/image-check.ts'
export { makeImageCompareTool } from './tools/image-compare.ts'
export { makeImageReportTool } from './tools/image-report.ts'

/**
 * Mount the three tools.
 * @param ctx - the plugin context (host).
 * @param config - raw plugin config.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const resolved = resolveConfig(config)
  const logger = ctx.logger('image-integrity')
  if (!resolved.enabled) {
    logger.info('disabled: enabled is false — no tools are mounted')
    return
  }
  const service = ctx.get('researchEvidence') as EvidencePort | undefined
  const runtime = new ImageRuntime({ config: resolved, ...(service === undefined ? {} : { service }) })
  if (service === undefined) {
    logger.info(`ctx.researchEvidence is not mounted; using a local core store under ${resolved.root}`)
  }
  ctx.effect(() => ctx.tools.register(makeImageCheckTool(runtime)), 'image-integrity: image_check tool')
  ctx.effect(() => ctx.tools.register(makeImageCompareTool(runtime)), 'image-integrity: image_compare tool')
  ctx.effect(() => ctx.tools.register(makeImageReportTool()), 'image-integrity: image_report tool')
}
