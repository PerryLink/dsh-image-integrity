/**
 * Block matching: duplicates, mirrors, false-positive controls.
 * @module test/analyze.spec
 */

import { describe, expect, it } from 'vitest'
import { analyzeImage, compareImages, hamming, ncc } from '../src/analyze.ts'
import { decodePng, encodeGreyPng } from '../src/png.ts'

/** Pattern for one 16×16 block. */
const SIDE = 16

/** Fill a block with a deterministic texture. */
function stamp(pixels: Uint8Array, width: number, originX: number, originY: number, flip: 'none' | 'horizontal' | 'vertical' = 'none'): void {
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      const sourceX = flip === 'horizontal' ? SIDE - 1 - x : x
      const sourceY = flip === 'vertical' ? SIDE - 1 - y : y
      pixels[(originY + y) * width + originX + x] = (sourceX * 7 + sourceY * 13 + ((sourceX * sourceY) >> 2)) % 251
    }
  }
}

/** Build an image (as RGBA) from a grey pixel buffer. */
function imageOf(pixels: Uint8Array, width: number, height: number) {
  return decodePng(encodeGreyPng(pixels, width, height))
}

describe('similarity primitives', () => {
  it('computes hamming distance and NCC', () => {
    expect(hamming(Uint8Array.from([0b1010]), Uint8Array.from([0b0001]))).toBe(3)
    expect(ncc(Float64Array.from([1, 2, 3]), Float64Array.from([2, 4, 6]))).toBeCloseTo(1, 6)
    expect(ncc(Float64Array.from([1, 2, 3]), Float64Array.from([3, 2, 1]))).toBeCloseTo(-1, 6)
  })
})

describe('single image', () => {
  it('finds a duplicated block at another position', () => {
    const pixels = new Uint8Array(64 * 64)
    stamp(pixels, 64, 0, 0)
    stamp(pixels, 64, 32, 32)
    const result = analyzeImage(imageOf(pixels, 64, 64))
    expect(result.duplicatePairs).toBeGreaterThanOrEqual(1)
    const match = result.matches[0]!
    expect(match.kind).toBe('duplicate')
    expect(match.hamming).toBeLessThanOrEqual(6)
    expect(match.ncc).toBeGreaterThanOrEqual(0.97)
  })

  it('finds a horizontally mirrored block', () => {
    const pixels = new Uint8Array(64 * 64)
    stamp(pixels, 64, 0, 0)
    stamp(pixels, 64, 32, 32, 'horizontal')
    const result = analyzeImage(imageOf(pixels, 64, 64))
    expect(result.flippedPairs).toBeGreaterThanOrEqual(1)
    expect(result.matches[0]!.kind).toBe('horizontal-flip')
  })

  it('does not flag a flat image', () => {
    const result = analyzeImage(imageOf(new Uint8Array(32 * 32), 32, 32))
    expect(result.matches).toEqual([])
    expect(result.considered).toBe(0)
    expect(result.warnings.join(' ')).toContain('flat image')
  })

  it('does not treat a smooth gradient as duplication', () => {
    const pixels = new Uint8Array(64 * 64)
    for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) pixels[y * 64 + x] = x * 4
    const result = analyzeImage(imageOf(pixels, 64, 64))
    expect(result.duplicatePairs).toBe(0)
  })

  it('reports the effective block size for an image smaller than the block size', () => {
    const pixels = new Uint8Array(8 * 8)
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) pixels[y * 8 + x] = (x * 37 + y * 91 + x * y * 17) % 251
    const result = analyzeImage(imageOf(pixels, 8, 8))
    expect(result.blockSize).toBe(8)
    expect(result.blocks).toBe(1)
    expect(result.considered).toBe(1)
  })
})

describe('pair', () => {
  it('finds shared blocks between two images', () => {
    const a = new Uint8Array(64 * 64)
    const b = new Uint8Array(64 * 64)
    stamp(a, 64, 0, 0)
    stamp(b, 64, 16, 16)
    const result = compareImages(imageOf(a, 64, 64), imageOf(b, 64, 64))
    expect(result.duplicatePairs).toBeGreaterThanOrEqual(1)
  })

  it('refuses a dimension mismatch instead of guessing', () => {
    const result = compareImages(imageOf(new Uint8Array(32 * 32), 32, 32), imageOf(new Uint8Array(64 * 64), 64, 64))
    expect(result.matches).toEqual([])
    expect(result.warnings.join(' ')).toContain('different dimensions')
  })
})
