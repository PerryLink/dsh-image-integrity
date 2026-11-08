/**
 * Runtime and tool surface: evidence, path safety, reports.
 * @module test/runtime-tools.spec
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateRep } from '@perrylink/dsh-research-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { encodeGreyPng } from '../src/png.ts'
import { ImageError, ImageRuntime } from '../src/runtime.ts'
import { makeImageCheckTool } from '../src/tools/image-check.ts'
import { makeImageCompareTool } from '../src/tools/image-compare.ts'
import { makeImageReportTool } from '../src/tools/image-report.ts'
import { VERSION } from '../src/version.ts'

const AT = new Date('2026-10-10T09:00:00.000Z')
let workspace: string
let store: string

/** A 64×64 image with the same textured 16×16 block twice. */
function duplicated(): Uint8Array {
  const pixels = new Uint8Array(64 * 64)
  for (const [originX, originY] of [[0, 0], [32, 32]] as const) {
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) pixels[(originY + y) * 64 + originX + x] = (x * 7 + y * 13 + ((x * y) >> 2)) % 251
    }
  }
  return pixels
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'image-work-'))
  store = await mkdtemp(path.join(tmpdir(), 'image-store-'))
  await writeFile(path.join(workspace, 'a.png'), encodeGreyPng(duplicated(), 64, 64))
  // A different file that still shares the same textured block.
  const other = duplicated()
  other.fill(0, 0, 16 * 64)
  await writeFile(path.join(workspace, 'b.png'), encodeGreyPng(other, 64, 64))
})

afterEach(async () => {
  for (const directory of [workspace, store]) {
    if (directory.startsWith(tmpdir())) await rm(directory, { recursive: true, force: true })
  }
})

/** Build a runtime over the fixtures. */
function runtime(): ImageRuntime {
  return new ImageRuntime({ config: resolveConfig({ workspaceRoot: workspace, root: store }), now: () => AT })
}

const EXEC = {} as never

describe('runtime', () => {
  it('finds a duplicate, stores evidence and writes a valid record', async () => {
    const result = await runtime().check({ path: 'a.png' })
    expect(result.analysis.duplicatePairs).toBeGreaterThanOrEqual(1)
    expect(result.evidenceId).toMatch(/^ev-/u)
    const record = JSON.parse(await readFile(result.recordPath!, 'utf8')) as unknown
    expect(validateRep(record).ok, JSON.stringify(validateRep(record).issues)).toBe(true)
  })

  it('compares two images and persists both snapshots', async () => {
    const result = await runtime().compare({ pathA: 'a.png', pathB: 'b.png' })
    expect(result.analysis.duplicatePairs).toBeGreaterThanOrEqual(1)
    const record = JSON.parse(await readFile(result.recordPath!, 'utf8')) as { evidence: Array<{ snapshotIds: string[] }> }
    expect(record.evidence[0]!.snapshotIds.length).toBe(2)
  })

  it('rejects traversal, JPEG, oversize and missing paths', async () => {
    await expect(runtime().check({ path: '../escape.png' })).rejects.toMatchObject({ code: 'PATH_ESCAPE' })
    await writeFile(path.join(workspace, 'x.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    await expect(runtime().check({ path: 'x.jpg' })).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' })
    const tiny = new ImageRuntime({ config: resolveConfig({ workspaceRoot: workspace, root: store, maxBytes: 10 }), now: () => AT })
    await expect(tiny.check({ path: 'a.png' })).rejects.toMatchObject({ code: 'TOO_LARGE' })
    const fewPixels = new ImageRuntime({ config: resolveConfig({ workspaceRoot: workspace, root: store, maxPixels: 10 }), now: () => AT })
    await expect(fewPixels.check({ path: 'a.png' })).rejects.toMatchObject({ code: 'TOO_LARGE' })
    await expect(runtime().check({ path: 'a.png', options: { blockSize: 0 } })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(runtime().check({})).rejects.toBeInstanceOf(ImageError)
  })
})

describe('tools', () => {
  it('declares names and schemas', () => {
    for (const [tool, name] of [
      [makeImageCheckTool(runtime()), 'image_check'],
      [makeImageCompareTool(runtime()), 'image_compare'],
      [makeImageReportTool(), 'image_report'],
    ] as const) {
      expect(tool.name).toBe(name)
      expect(Object.keys(tool.parameters).length).toBeGreaterThan(0)
      expect(tool.output.schema).toBeDefined()
    }
  })

  it('check → report produces Markdown and SARIF', async () => {
    const check = (await makeImageCheckTool(runtime()).execute({ path: 'a.png' }, EXEC)) as { ok: true; analysis: unknown }
    expect(check.ok).toBe(true)
    const report = (await makeImageReportTool().execute({ analysis: check.analysis }, EXEC)) as {
      ok: true
      markdown: string
      sarif: { version: string; runs: Array<{ results: unknown[] }> }
    }
    expect(report.markdown).toContain('Image integrity check')
    expect(report.sarif.version).toBe('2.1.0')
    expect(report.sarif.runs[0]!.results.length).toBeGreaterThanOrEqual(1)
  })

  it('compare and failure branches', async () => {
    const compare = (await makeImageCompareTool(runtime()).execute({ pathA: 'a.png', pathB: 'b.png' }, EXEC)) as { ok: true; analysis: { duplicatePairs: number } }
    expect(compare.analysis.duplicatePairs).toBeGreaterThanOrEqual(1)
    const failure = (await makeImageCheckTool(runtime()).execute({ path: '' }, EXEC)) as { ok: false; error: { code: string } }
    expect(failure.ok).toBe(false)
    expect(failure.error.code).toBe('INVALID_INPUT')
  })

  it('image_report rejects a malformed analysis instead of throwing', async () => {
    const value = (await makeImageReportTool().execute({ analysis: {} }, EXEC)) as { ok: false; error: { code: string } }
    expect(value.ok).toBe(false)
    expect(value.error.code).toBe('INVALID_INPUT')
  })
})

describe('package', () => {
  it('VERSION matches package.json and the manifest declares a bundle patch', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>
    expect(pkg['version']).toBe(VERSION)
    expect(pkg['dsh']).toEqual({ manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } })
    expect(pkg['dependencies']).toEqual({})
  })
})
