/**
 * Block-level duplication and mirroring detection.
 *
 * Each block is reduced to a mean-threshold bit pattern (robust to additive
 * brightness changes) plus its zero-mean normalised correlation (NCC) for
 * confirmation. Blocks with too little variance (flat backgrounds) are skipped,
 * which is the main defence against false positives on uniform areas.
 *
 * This detects **reused pixels**, not manipulation intent: a duplicated control
 * panel is normal, a duplicated experimental panel usually is not. The report
 * always says which regions matched and at what score.
 *
 * @module dsh-image-integrity/analyze
 */

import type { RgbaImage } from './png.ts'

/** Options shared by single-image and pair analysis. */
export interface ImageOptions {
  /** Block side in pixels (default 16). */
  readonly blockSize?: number
  /** Maximum Hamming distance on the block bit pattern (default 6 of 256). */
  readonly maxShiftBits?: number
  /** Minimum block variance; flatter blocks are ignored (default 6). */
  readonly minVariance?: number
  /** NCC confirmation threshold (default 0.97). */
  readonly nccThreshold?: number
}

/** A matched region. */
export interface RegionMatch {
  readonly kind: 'duplicate' | 'horizontal-flip' | 'vertical-flip'
  readonly a: { readonly x: number; readonly y: number; readonly block: number }
  readonly b: { readonly x: number; readonly y: number; readonly block: number }
  readonly hamming: number
  readonly ncc: number
}

/** Result of analysing one image. */
export interface ImageAnalysis {
  readonly width: number
  readonly height: number
  readonly blockSize: number
  readonly blocks: number
  readonly considered: number
  readonly matches: readonly RegionMatch[]
  readonly duplicatePairs: number
  readonly flippedPairs: number
  readonly warnings: readonly string[]
}

/** Result of comparing two images. */
export interface PairAnalysis {
  readonly a: { readonly width: number; readonly height: number }
  readonly b: { readonly width: number; readonly height: number }
  readonly matches: readonly RegionMatch[]
  readonly duplicatePairs: number
  readonly flippedPairs: number
  readonly warnings: readonly string[]
}

/** One block with its features. */
interface Block {
  readonly x: number
  readonly y: number
  readonly index: number
  readonly variance: number
  /** Variance left after removing the best-fit plane; a perfect ramp has ~0. */
  readonly residual: number
  readonly bits: Uint8Array
  /** Bit pattern of the horizontally mirrored block. */
  readonly horizontalBits: Uint8Array
  /** Bit pattern of the vertically mirrored block. */
  readonly verticalBits: Uint8Array
  readonly values: Float64Array
}

/** Convert to luma. */
export function toGray(image: RgbaImage): Float64Array {
  const gray = new Float64Array(image.width * image.height)
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4
    gray[index] = 0.299 * image.pixels[offset]! + 0.587 * image.pixels[offset + 1]! + 0.114 * image.pixels[offset + 2]!
  }
  return gray
}

/**
 * Hamming distance between two bit arrays.
 * @param left - first bits.
 * @param right - second bits.
 * @param limit - stop early once the distance exceeds this (default: exact).
 * @returns the exact distance, or a value greater than `limit`.
 */
export function hamming(left: Uint8Array, right: Uint8Array, limit = Number.POSITIVE_INFINITY): number {
  let distance = 0
  for (let index = 0; index < left.length; index += 1) {
    let xor = left[index]! ^ right[index]!
    while (xor !== 0) {
      distance += xor & 1
      xor >>>= 1
    }
    if (distance > limit) return distance
  }
  return distance
}

/** Zero-mean NCC of two equal-length vectors. */
export function ncc(left: Float64Array, right: Float64Array): number {
  const n = left.length
  let meanLeft = 0
  let meanRight = 0
  for (let index = 0; index < n; index += 1) {
    meanLeft += left[index]!
    meanRight += right[index]!
  }
  meanLeft /= n
  meanRight /= n
  let numerator = 0
  let denomLeft = 0
  let denomRight = 0
  for (let index = 0; index < n; index += 1) {
    const a = left[index]! - meanLeft
    const b = right[index]! - meanRight
    numerator += a * b
    denomLeft += a * a
    denomRight += b * b
  }
  const denominator = Math.sqrt(denomLeft * denomRight)
  return denominator === 0 ? 0 : numerator / denominator
}

/** Mean-threshold bits of a block's values. */
function bitsOf(values: Float64Array): Uint8Array {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const bits = new Uint8Array(Math.ceil(values.length / 8))
  for (let index = 0; index < values.length; index += 1) {
    if (values[index]! > mean) bits[index >> 3] = bits[index >> 3]! | (1 << (index & 7))
  }
  return bits
}

/** Mirror a square block horizontally or vertically. */
function mirror(values: Float64Array, size: number, axis: 'horizontal' | 'vertical'): Float64Array {
  const result = new Float64Array(values.length)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourceX = axis === 'horizontal' ? size - 1 - x : x
      const sourceY = axis === 'vertical' ? size - 1 - y : y
      result[y * size + x] = values[sourceY * size + sourceX]!
    }
  }
  return result
}

/** Extract non-flat blocks. */
function blocksOf(image: RgbaImage, options: Required<ImageOptions>): Block[] {
  const size = Math.min(options.blockSize, image.width, image.height)
  const gray = toGray(image)
  const columns = Math.floor(image.width / size)
  const rows = Math.floor(image.height / size)
  const blocks: Block[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const values = new Float64Array(size * size)
      let sum = 0
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const value = gray[(row * size + y) * image.width + column * size + x]!
          values[y * size + x] = value
          sum += value
        }
      }
      const mean = sum / values.length
      let variance = 0
      for (const value of values) variance += (value - mean) ** 2
      variance /= values.length
      // Remove a fitted plane: a smooth linear ramp would otherwise hash like
      // every other block of the ramp and be reported as "duplicated".
      const center = (size - 1) / 2
      let slopeX = 0
      let slopeY = 0
      let sumX2 = 0
      let sumY2 = 0
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const dx = x - center
          const dy = y - center
          const value = values[y * size + x]!
          slopeX += value * dx
          slopeY += value * dy
          sumX2 += dx * dx
          sumY2 += dy * dy
        }
      }
      slopeX = sumX2 === 0 ? 0 : slopeX / sumX2
      slopeY = sumY2 === 0 ? 0 : slopeY / sumY2
      let residual = 0
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const predicted = mean + slopeX * (x - center) + slopeY * (y - center)
          residual += (values[y * size + x]! - predicted) ** 2
        }
      }
      residual /= values.length
      const bits = bitsOf(values)
      blocks.push({
        x: column * size,
        y: row * size,
        index: blocks.length,
        variance,
        residual,
        bits,
        horizontalBits: bitsOf(mirror(values, size, 'horizontal')),
        verticalBits: bitsOf(mirror(values, size, 'vertical')),
        values,
      })
    }
  }
  return blocks
}

/** True when two blocks are neighbours (diagonal included). */
function adjacent(left: Block, right: Block): boolean {
  const side = Math.round(Math.sqrt(left.values.length))
  return Math.abs(left.x - right.x) <= side && Math.abs(left.y - right.y) <= side
}

/** Best match kind for a pair, if any. */
function classify(left: Block, right: Block, size: number, options: Required<ImageOptions>): RegionMatch | undefined {
  const directDistance = hamming(left.bits, right.bits, options.maxShiftBits)
  if (directDistance <= options.maxShiftBits && ncc(left.values, right.values) >= options.nccThreshold) {
    return { kind: 'duplicate', a: { x: left.x, y: left.y, block: size }, b: { x: right.x, y: right.y, block: size }, hamming: directDistance, ncc: Number(ncc(left.values, right.values).toFixed(4)) }
  }
  for (const axis of ['horizontal', 'vertical'] as const) {
    const mirrorBits = axis === 'horizontal' ? right.horizontalBits : right.verticalBits
    const distance = hamming(left.bits, mirrorBits, options.maxShiftBits)
    if (distance <= options.maxShiftBits) {
      const mirrored = mirror(right.values, size, axis)
      if (ncc(left.values, mirrored) >= options.nccThreshold) {
        return {
          kind: axis === 'horizontal' ? 'horizontal-flip' : 'vertical-flip',
          a: { x: left.x, y: left.y, block: size },
          b: { x: right.x, y: right.y, block: size },
          hamming: distance,
          ncc: Number(ncc(left.values, mirrored).toFixed(4)),
        }
      }
    }
  }
  return undefined
}

/**
 * Fill defaults and validate thresholds.
 *
 * Validation lives here (not only in the runtime) because `analyzeImage` and
 * `compareImages` are exported: `blockSize: 0` would otherwise divide by zero
 * and loop forever, and a negative/NaN variance or out-of-range NCC threshold
 * would silently change every result.
 * @param options - caller overrides.
 * @returns fully resolved options.
 */
export function resolveImageOptions(options: ImageOptions = {}): Required<ImageOptions> {
  const blockSize = options.blockSize ?? 16
  if (!Number.isSafeInteger(blockSize) || blockSize < 2 || blockSize > 256) {
    throw new RangeError('blockSize must be an integer between 2 and 256')
  }
  const maxShiftBits = options.maxShiftBits ?? 6
  if (!Number.isSafeInteger(maxShiftBits) || maxShiftBits < 0 || maxShiftBits > blockSize * blockSize) {
    throw new RangeError(`maxShiftBits must be an integer between 0 and ${blockSize * blockSize}`)
  }
  const minVariance = options.minVariance ?? 6
  if (!Number.isFinite(minVariance) || minVariance < 0) throw new RangeError('minVariance must be a finite non-negative number')
  const nccThreshold = options.nccThreshold ?? 0.97
  if (!Number.isFinite(nccThreshold) || nccThreshold < 0 || nccThreshold > 1) throw new RangeError('nccThreshold must be between 0 and 1')
  return { blockSize, maxShiftBits, minVariance, nccThreshold }
}

/** Deduplicate A↔B matches. */
function dedupe(matches: RegionMatch[]): RegionMatch[] {
  const seen = new Set<string>()
  const result: RegionMatch[] = []
  for (const match of matches) {
    const left = `${match.a.x},${match.a.y}`
    const right = `${match.b.x},${match.b.y}`
    const key = [match.kind, left, right].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(match)
  }
  return result
}

/**
 * Analyse one image for reused blocks and mirrored copies.
 * @param image - decoded image.
 * @param options - detection thresholds.
 * @returns matches and counts.
 */
export function analyzeImage(image: RgbaImage, options: ImageOptions = {}): ImageAnalysis {
  const resolved = resolveImageOptions(options)
  const size = Math.min(resolved.blockSize, image.width, image.height)
  const blocks = blocksOf(image, resolved).filter(block => block.variance >= resolved.minVariance && block.residual >= resolved.minVariance)
  const matches: RegionMatch[] = []
  for (let left = 0; left < blocks.length; left += 1) {
    for (let right = left + 1; right < blocks.length; right += 1) {
      const first = blocks[left]!
      const second = blocks[right]!
      if (adjacent(first, second)) continue
      const match = classify(first, second, size, resolved)
      if (match !== undefined) matches.push(match)
    }
  }
  const unique = dedupe(matches)
  return {
    width: image.width,
    height: image.height,
    blockSize: size,
    blocks: Math.floor(image.width / size) * Math.floor(image.height / size),
    considered: blocks.length,
    matches: unique,
    duplicatePairs: unique.filter(match => match.kind === 'duplicate').length,
    flippedPairs: unique.filter(match => match.kind !== 'duplicate').length,
    warnings: [
      'block matching finds reused pixels, not manipulation intent: duplicated control panels and repeated icons are normal',
      'only 8-bit non-interlaced PNG (grey/RGB/RGBA) is decoded; JPEG is not supported',
      ...(blocks.length === 0 ? ['no block had enough texture to compare; a flat image cannot be assessed'] : []),
    ],
  }
}

/**
 * Compare two images block by block.
 * @param left - first image.
 * @param right - second image.
 * @param options - detection thresholds.
 * @returns cross-image matches and counts.
 */
export function compareImages(left: RgbaImage, right: RgbaImage, options: ImageOptions = {}): PairAnalysis {
  if (left.width !== right.width || left.height !== right.height) {
    return {
      a: { width: left.width, height: left.height },
      b: { width: right.width, height: right.height },
      matches: [],
      duplicatePairs: 0,
      flippedPairs: 0,
      warnings: ['images have different dimensions; no resize is attempted, so no comparison was made'],
    }
  }
  const resolved = resolveImageOptions(options)
  const size = Math.min(resolved.blockSize, left.width, left.height)
  const leftBlocks = blocksOf(left, resolved).filter(block => block.variance >= resolved.minVariance && block.residual >= resolved.minVariance)
  const rightBlocks = blocksOf(right, resolved).filter(block => block.variance >= resolved.minVariance && block.residual >= resolved.minVariance)
  const matches: RegionMatch[] = []
  for (const first of leftBlocks) {
    for (const second of rightBlocks) {
      const match = classify(first, second, size, resolved)
      if (match !== undefined) matches.push(match)
    }
  }
  const unique = dedupe(matches)
  return {
    a: { width: left.width, height: left.height },
    b: { width: right.width, height: right.height },
    matches: unique,
    duplicatePairs: unique.filter(match => match.kind === 'duplicate').length,
    flippedPairs: unique.filter(match => match.kind !== 'duplicate').length,
    warnings: [
      'shared blocks can be legitimate (same control, same scale bar, same background texture)',
      'images must have identical dimensions; no resize or alignment is attempted',
    ],
  }
}
