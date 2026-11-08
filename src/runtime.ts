/**
 * Runtime: workspace-safe image loading, REP evidence and analysis orchestration.
 * @module dsh-image-integrity/runtime
 */

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  EvidenceStore,
  RepStoreError,
  sha256Hex,
  stableId,
  validateRep,
  type AddEvidenceInput,
  type CaptureInput,
  type CheckResult,
  type Evidence,
  type ResearchRecord,
  type Snapshot,
} from '@perrylink/dsh-research-core'
import type { ResolvedConfig } from './config.ts'
import { analyzeImage, compareImages, resolveImageOptions, type ImageAnalysis, type ImageOptions, type PairAnalysis } from './analyze.ts'
import { decodePng, PngError, type RgbaImage } from './png.ts'
import { VERSION } from './version.ts'

/** Stable error codes. */
export type ImageErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'PATH_ESCAPE' | 'NOT_A_FILE' | 'TOO_LARGE' | 'UNSUPPORTED_IMAGE' | 'STORE_ERROR'

/** A typed failure. */
export class ImageError extends Error {
  /** Stable code. */
  readonly code: ImageErrorCode

  constructor(code: ImageErrorCode, message: string) {
    super(message)
    this.name = 'ImageError'
    this.code = code
  }
}

/** The subset of the REP service used here. */
export interface EvidencePort {
  capture(input: CaptureInput): Promise<{ snapshot: Snapshot }>
  addEvidence(input: AddEvidenceInput): Promise<{ evidence: Evidence }>
  buildRecord(options?: { evidenceIds?: readonly string[] }): Promise<Omit<ResearchRecord, 'manifest'>>
}

/** One loaded image. */
export interface LoadedImage {
  readonly id: string
  readonly absolute: string
  readonly bytes: Uint8Array
  readonly image: RgbaImage
}

/** Result of `check`. */
export interface CheckResultValue {
  readonly analysis: ImageAnalysis
  readonly evidenceId?: string
  readonly recordPath?: string
}

/** Result of `compare`. */
export interface CompareResultValue {
  readonly analysis: PairAnalysis
  readonly evidenceId?: string
  readonly recordPath?: string
}

/** Options for {@link ImageRuntime}. */
export interface ImageRuntimeOptions {
  readonly config: ResolvedConfig
  readonly service?: EvidencePort
  readonly now?: () => Date
}

/** True when `candidate` is inside `root`. */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
}

/** The runtime. */
export class ImageRuntime {
  readonly config: ResolvedConfig

  readonly #service: EvidencePort | undefined
  readonly #now: () => Date
  #store: EvidenceStore | undefined

  constructor(options: ImageRuntimeOptions) {
    this.config = options.config
    this.#service = options.service
    this.#now = options.now ?? (() => new Date())
  }

  /** Current ISO timestamp. */
  iso(): string {
    return this.#now().toISOString()
  }

  /** The evidence port. */
  port(): EvidencePort {
    if (this.#service !== undefined) return this.#service
    this.#store ??= new EvidenceStore(path.join(this.config.root, 'store'))
    return this.#store
  }

  /** Thresholds from config, overridden per call. */
  options(overrides: ImageOptions = {}): ImageOptions {
    try {
      return resolveImageOptions({
        blockSize: overrides.blockSize ?? this.config.blockSize,
        maxShiftBits: overrides.maxShiftBits ?? this.config.maxShiftBits,
        minVariance: overrides.minVariance ?? this.config.minVariance,
        nccThreshold: overrides.nccThreshold ?? this.config.nccThreshold,
      })
    } catch (error) {
      throw new ImageError('INVALID_INPUT', (error as Error).message)
    }
  }

  /** Load one workspace image. */
  async load(input: string): Promise<LoadedImage> {
    if (typeof input !== 'string' || input.trim() === '') throw new ImageError('INVALID_INPUT', 'path must be a non-empty string')
    let realRoot: string
    try {
      realRoot = await realpath(this.config.workspaceRoot)
    } catch {
      throw new ImageError('NOT_FOUND', `workspace root does not exist: ${this.config.workspaceRoot}`)
    }
    const candidate = path.resolve(realRoot, input)
    if (!isInside(realRoot, candidate)) throw new ImageError('PATH_ESCAPE', 'path resolves outside the workspace root')
    let real: string
    try {
      real = await realpath(candidate)
    } catch {
      throw new ImageError('NOT_FOUND', `image not found: ${input}`)
    }
    if (!isInside(realRoot, real)) throw new ImageError('PATH_ESCAPE', 'path escapes the workspace root through a symlink')
    const info = await stat(real)
    if (!info.isFile()) throw new ImageError('NOT_A_FILE', `not a regular file: ${input}`)
    if (info.size > this.config.maxBytes) throw new ImageError('TOO_LARGE', `image is ${info.size} bytes, the cap is ${this.config.maxBytes}`)
    const bytes = await readFile(real)
    let image: RgbaImage
    try {
      image = decodePng(bytes, { maxPixels: this.config.maxPixels })
    } catch (error) {
      if (error instanceof PngError && error.code === 'TOO_LARGE') throw new ImageError('TOO_LARGE', error.message)
      if (error instanceof PngError) throw new ImageError('UNSUPPORTED_IMAGE', error.message)
      throw new ImageError('UNSUPPORTED_IMAGE', `could not decode the image: ${(error as Error).message}`)
    }
    return { id: path.relative(realRoot, real).split(path.sep).join('/'), absolute: real, bytes, image }
  }

  /** Store evidence + record for one or two images. */
  async #persist(images: readonly LoadedImage[], title: string, checks: readonly CheckResult[], notes: string): Promise<{ evidenceId: string; recordPath: string }> {
    const port = this.port()
    try {
      const snapshotIds: Array<`sha256:${string}`> = []
      const anchors: Array<{ snapshotId: `sha256:${string}`; kind: 'figure'; value: string; ordinal: number; label?: string }> = []
      for (const image of images) {
        const digest = `sha256:${sha256Hex(image.bytes)}` as `sha256:${string}`
        if (snapshotIds.includes(digest)) continue
        const captured = await port.capture({
          bytes: image.bytes,
          mediaType: 'image/png',
          sourceRef: { kind: 'file', id: image.id, retrievedAt: this.iso() },
          capturedAt: this.iso(),
        })
        snapshotIds.push(captured.snapshot.snapshotId)
        anchors.push({ snapshotId: captured.snapshot.snapshotId, kind: 'figure', value: `f.${snapshotIds.length}`, ordinal: snapshotIds.length, label: sha256Hex(image.bytes) })
      }
      const evidence = (
        await port.addEvidence({
          evidenceId: stableId('ev', ['image-integrity', title, ...snapshotIds]),
          title,
          sourceRef: { kind: 'file', id: images[0]!.id, retrievedAt: this.iso() },
          snapshotIds,
          anchors,
          provenance: { plugin: 'dsh-image-integrity', version: VERSION, method: 'png-block-hash', retrievedAt: this.iso() },
          checks,
          notes: `${notes}${images[1] === undefined ? '' : `; compared with ${images[1].id}`}`,
        })
      ).evidence
      const record = await port.buildRecord({ evidenceIds: [evidence.evidenceId] })
      if (!validateRep(record).ok) throw new ImageError('STORE_ERROR', 'refusing to write an invalid REP record')
      const directory = path.join(this.config.root, 'records')
      await mkdir(directory, { recursive: true })
      const file = path.join(directory, `${evidence.evidenceId}.rep.json`)
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      return { evidenceId: evidence.evidenceId, recordPath: file }
    } catch (error) {
      if (error instanceof ImageError) throw error
      if (error instanceof RepStoreError) throw new ImageError('STORE_ERROR', error.message)
      throw new ImageError('STORE_ERROR', `could not store the evidence: ${(error as Error).message}`)
    }
  }

  /**
   * Analyse one image.
   * @param request - path, thresholds and persistence.
   * @returns the match report.
   */
  async check(request: { path?: string; options?: ImageOptions; persist?: boolean }): Promise<CheckResultValue> {
    if (typeof request.path !== 'string') throw new ImageError('INVALID_INPUT', 'path is required')
    const image = await this.load(request.path)
    const analysis = analyzeImage(image.image, this.options(request.options))
    const checks: CheckResult[] = analysis.matches.map((match, index) => ({
      checkId: `chk-img-${index + 1}`,
      check: 'other' as const,
      status: 'warn' as const,
      severity: 'warning' as const,
      detail: `${match.kind} at ${match.a.x},${match.a.y} and ${match.b.x},${match.b.y} (ncc ${match.ncc})`,
      actual: { kind: match.kind, a: match.a, b: match.b, hamming: match.hamming, ncc: match.ncc },
    }))
    const persist = request.persist ?? this.config.persist
    if (!persist) return { analysis }
    const stored = await this.#persist([image], `Image check: ${image.id}`, checks, `${analysis.duplicatePairs} duplicate, ${analysis.flippedPairs} mirrored region(s)`)
    return { analysis, ...stored }
  }

  /**
   * Compare two images.
   * @param request - two paths, thresholds and persistence.
   * @returns the cross-image report.
   */
  async compare(request: { pathA?: string; pathB?: string; options?: ImageOptions; persist?: boolean }): Promise<CompareResultValue> {
    if (typeof request.pathA !== 'string' || typeof request.pathB !== 'string') throw new ImageError('INVALID_INPUT', 'pathA and pathB are required')
    const left = await this.load(request.pathA)
    const right = await this.load(request.pathB)
    const analysis = compareImages(left.image, right.image, this.options(request.options))
    const checks: CheckResult[] = analysis.matches.map((match, index) => ({
      checkId: `chk-pair-${index + 1}`,
      check: 'other' as const,
      status: 'warn' as const,
      severity: 'warning' as const,
      detail: `${match.kind} between ${left.id} (${match.a.x},${match.a.y}) and ${right.id} (${match.b.x},${match.b.y}) (ncc ${match.ncc})`,
      actual: { kind: match.kind, hamming: match.hamming, ncc: match.ncc },
    }))
    const persist = request.persist ?? this.config.persist
    if (!persist) return { analysis }
    const stored = await this.#persist([left, right], `Image comparison: ${left.id} vs ${right.id}`, checks, `${analysis.duplicatePairs} duplicate, ${analysis.flippedPairs} mirrored shared region(s)`)
    return { analysis, ...stored }
  }
}
