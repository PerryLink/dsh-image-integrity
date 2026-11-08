/**
 * PNG codec: round-trip, rejection branches.
 * @module test/png.spec
 */

import { describe, expect, it } from 'vitest'
import { PngError, decodePng, encodeGreyPng } from '../src/png.ts'

/** A deterministic textured buffer. */
function pattern(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) pixels[y * width + x] = (x * 7 + y * 13 + ((x * y) >> 2)) % 251
  }
  return pixels
}

describe('png', () => {
  it('round-trips an 8-bit greyscale image', () => {
    const pixels = pattern(24, 18)
    const decoded = decodePng(encodeGreyPng(pixels, 24, 18))
    expect(decoded.width).toBe(24)
    expect(decoded.height).toBe(18)
    for (let index = 0; index < pixels.length; index += 1) {
      const grey = decoded.pixels[index * 4]
      expect(grey).toBe(pixels[index])
      expect(decoded.pixels[index * 4 + 3]).toBe(255)
    }
  })

  it('rejects non-PNG bytes', () => {
    expect(() => decodePng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toThrow(PngError)
  })

  it('rejects an unsupported bit depth', () => {
    const png = encodeGreyPng(pattern(8, 8), 8, 8)
    png[24] = 16
    expect(() => decodePng(png)).toThrow(/8-bit/u)
  })

  it('rejects a truncated file', () => {
    const png = encodeGreyPng(pattern(8, 8), 8, 8)
    expect(() => decodePng(png.subarray(0, 10))).toThrow(PngError)
  })
})
