/**
 * Minimal PNG codec (8-bit, non-interlaced) built on `node:zlib`.
 *
 * Supported: colour types 0 (grey), 2 (RGB), 6 (RGBA), bit depth 8, interlace 0.
 * Everything else is rejected with a clear code instead of being misread; JPEG
 * is not decoded at all (documented limitation).
 *
 * @module dsh-image-integrity/png
 */

import { deflateSync, inflateSync } from 'node:zlib'

/** A decoded image as straight RGBA bytes. */
export interface RgbaImage {
  readonly width: number
  readonly height: number
  /** RGBA, 4 bytes per pixel, row-major. */
  readonly pixels: Uint8Array
}

/** Decode failure codes. */
export type PngErrorCode = 'NOT_PNG' | 'TRUNCATED' | 'BAD_CHUNK' | 'UNSUPPORTED' | 'TOO_LARGE'

/** Decoder bounds. */
export interface DecodePngOptions {
  /** Maximum decoded pixels (default 4,000,000); larger headers are rejected before inflating. */
  readonly maxPixels?: number
}

/** Default pixel bound; the runtime passes its configured value instead. */
const DEFAULT_MAX_PIXELS = 4_000_000

/** A typed decode failure. */
export class PngError extends Error {
  /** Stable code. */
  readonly code: PngErrorCode

  constructor(code: PngErrorCode, message: string) {
    super(message)
    this.name = 'PngError'
    this.code = code
  }
}

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Read a big-endian u32. */
function u32(data: Uint8Array, offset: number): number {
  return ((data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0
}

/** Check the signature. */
function hasSignature(data: Uint8Array): boolean {
  if (data.length < SIGNATURE.length) return false
  return SIGNATURE.every((byte, index) => data[index] === byte)
}

/** Read the IHDR fields. */
interface Header {
  readonly width: number
  readonly height: number
  readonly bitDepth: number
  readonly colorType: number
  readonly interlace: number
}

/** Parse IHDR. */
function parseHeader(data: Uint8Array): Header {
  if (data.length < 33) throw new PngError('TRUNCATED', 'file is too short to contain IHDR')
  const length = u32(data, 8)
  const type = String.fromCharCode(data[12]!, data[13]!, data[14]!, data[15]!)
  if (type !== 'IHDR' || length !== 13) throw new PngError('BAD_CHUNK', 'the first chunk is not a 13-byte IHDR')
  return {
    width: u32(data, 16),
    height: u32(data, 20),
    bitDepth: data[24]!,
    colorType: data[25]!,
    interlace: data[28]!,
  }
}

/** CRC32 table. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC32 of a byte range. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Unfilter one scanline in place. */
function unfilter(line: Uint8Array, previous: Uint8Array, filter: number, bpp: number): void {
  switch (filter) {
    case 0:
      return
    case 1:
      for (let index = bpp; index < line.length; index += 1) line[index] = (line[index]! + line[index - bpp]!) & 0xff
      return
    case 2:
      for (let index = 0; index < line.length; index += 1) line[index] = (line[index]! + previous[index]!) & 0xff
      return
    case 3:
      for (let index = 0; index < line.length; index += 1) {
        const left = index >= bpp ? line[index - bpp]! : 0
        line[index] = (line[index]! + ((left + previous[index]!) >> 1)) & 0xff
      }
      return
    case 4:
      for (let index = 0; index < line.length; index += 1) {
        const left = index >= bpp ? line[index - bpp]! : 0
        const up = previous[index]!
        const upLeft = index >= bpp ? previous[index - bpp]! : 0
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        line[index] = (line[index]! + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff
      }
      return
    default:
      throw new PngError('BAD_CHUNK', `unknown filter type ${filter}`)
  }
}

/**
 * Decode a PNG buffer.
 * @param data - the file bytes.
 * @param options - pixel bound; enforced before any inflation/output allocation.
 * @returns the RGBA image.
 */
export function decodePng(data: Uint8Array, options: DecodePngOptions = {}): RgbaImage {
  if (!hasSignature(data)) throw new PngError('NOT_PNG', 'the file does not start with the PNG signature')
  const header = parseHeader(data)
  if (header.bitDepth !== 8) throw new PngError('UNSUPPORTED', `only 8-bit PNGs are supported, got ${header.bitDepth}-bit`)
  if (header.interlace !== 0) throw new PngError('UNSUPPORTED', 'interlaced PNGs are not supported')
  if (![0, 2, 6].includes(header.colorType)) throw new PngError('UNSUPPORTED', `colour type ${header.colorType} is not supported (0, 2, 6 only)`)
  if (header.width === 0 || header.height === 0) throw new PngError('BAD_CHUNK', 'zero-dimension image')
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) throw new PngError('BAD_CHUNK', 'maxPixels must be a positive safe integer')
  if (header.width * header.height > maxPixels) {
    throw new PngError('TOO_LARGE', `image is ${header.width}x${header.height}, above the ${maxPixels}-pixel cap`)
  }

  const channels = header.colorType === 0 ? 1 : header.colorType === 2 ? 3 : 4
  const idat: Uint8Array[] = []
  let offset = 8
  let sawEnd = false
  while (offset + 8 <= data.length) {
    const length = u32(data, offset)
    const type = String.fromCharCode(data[offset + 4]!, data[offset + 5]!, data[offset + 6]!, data[offset + 7]!)
    const start = offset + 8
    const end = start + length
    if (end + 4 > data.length) throw new PngError('TRUNCATED', `chunk ${type} is truncated`)
    const body = data.subarray(start, end)
    if (type === 'IDAT') idat.push(body)
    if (type === 'IEND') {
      sawEnd = true
      break
    }
    offset = end + 4
  }
  if (!sawEnd) throw new PngError('TRUNCATED', 'no IEND chunk')
  if (idat.length === 0) throw new PngError('BAD_CHUNK', 'no IDAT chunk')

  const stride = header.width * channels
  const expected = (stride + 1) * header.height
  let raw: Uint8Array
  try {
    // maxOutputLength is the inflate-side half of the pixel cap: a small
    // compressed IDAT must not be able to inflate into a huge buffer.
    raw = inflateSync(Buffer.concat(idat.map(part => Buffer.from(part))), { maxOutputLength: expected })
  } catch (error) {
    throw new PngError('BAD_CHUNK', `IDAT does not inflate: ${(error as Error).message}`)
  }
  if (raw.length < expected) throw new PngError('TRUNCATED', `expected ${expected} inflated bytes, got ${raw.length}`)

  const pixels = new Uint8Array(header.width * header.height * 4)
  let previous = new Uint8Array(stride)
  for (let row = 0; row < header.height; row += 1) {
    const start = row * (stride + 1)
    const filter = raw[start]!
    const line = raw.slice(start + 1, start + 1 + stride)
    unfilter(line, previous, filter, channels)
    for (let column = 0; column < header.width; column += 1) {
      const source = column * channels
      const target = (row * header.width + column) * 4
      if (channels === 1) {
        const grey = line[source]!
        pixels[target] = grey
        pixels[target + 1] = grey
        pixels[target + 2] = grey
        pixels[target + 3] = 255
      } else {
        pixels[target] = line[source]!
        pixels[target + 1] = line[source + 1]!
        pixels[target + 2] = line[source + 2]!
        pixels[target + 3] = channels === 4 ? line[source + 3]! : 255
      }
    }
    previous = line
  }
  return { width: header.width, height: header.height, pixels }
}

/** Build one PNG chunk. */
function chunk(type: string, body: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'latin1')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(body)])), 0)
  return Buffer.concat([length, typeBytes, Buffer.from(body), crc])
}

/**
 * Encode an 8-bit greyscale PNG (filter 0), used by tests and the bench
 * generator. Not optimised: simplicity and determinism matter here.
 * @param pixels - one byte per pixel, row-major.
 * @param width - image width.
 * @param height - image height.
 * @returns the PNG bytes.
 */
export function encodeGreyPng(pixels: Uint8Array, width: number, height: number): Buffer {
  if (pixels.length !== width * height) throw new PngError('BAD_CHUNK', 'pixel count does not match the dimensions')
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 0
  header[10] = 0
  header[11] = 0
  header[12] = 0
  const raw = Buffer.alloc((width + 1) * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * (width + 1)] = 0
    Buffer.from(pixels.subarray(row * width, (row + 1) * width)).copy(raw, row * (width + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ])
}
