# dsh-image-integrity

**Is that panel reused — duplicated in place, or pasted mirrored from another figure?**

*Zero-dependency PNG decoding, mean-threshold block fingerprints with NCC confirmation, duplicate/mirror region reports, REP evidence and SARIF. It finds reused pixels, not manipulation intent.*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()

English · [简体中文](README-zh.md)

---

## What it does

- **`image_check`** — finds a textured block that appears twice (or mirrored) inside one image.
- **`image_compare`** — finds blocks shared between two images, including mirrored copies.
- **`image_report`** — Markdown + SARIF 2.1.0, one warning per matched region with coordinates, Hamming distance and NCC.

How it works: decode PNG → luma → 16×16 blocks → mean-threshold bit pattern (robust to brightness offsets) + zero-mean NCC confirmation. Blocks that are flat **or close to a fitted plane** are skipped, so a smooth gradient is not reported as "duplicated".

## What it does not do

- **No JPEG.** Only 8-bit non-interlaced PNG (grey/RGB/RGBA) is decoded. JPEG/16-bit/interlaced are rejected with a clear code — no silent garbage.
- **No alignment.** Images must have identical dimensions; a mismatch is reported, never resized.
- **No blur/compression robustness.** JPEG recompression, scaling, rotation or splice blending will usually defeat it.
- **No misconduct claim.** Repeated controls, scale bars, icons and background texture are legitimate shared blocks. The report says so.
- **No GUI, no upload.** Local bytes only.

## Tools

### `image_check`

`{ path, persist?, blockSize?, maxShiftBits?, minVariance?, nccThreshold? }` → `{ ok, analysis, evidenceId?, recordPath? }`.

### `image_compare`

`{ pathA, pathB, persist?, ...thresholds }` → `{ ok, analysis, evidenceId?, recordPath? }`.

### `image_report`

`{ analysis, imageId? }` → `{ ok, markdown, sarif }`.

### Error codes

`INVALID_INPUT` · `NOT_FOUND` · `PATH_ESCAPE` · `NOT_A_FILE` · `TOO_LARGE` · `UNSUPPORTED_IMAGE` · `STORE_ERROR`

## Compatibility & install

| | |
|---|---|
| DeepSeek Harness | **`dsh-v0.2.1-rc.5`** (verified 2026-11-08); peer `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0` (tested `24.22.1`), ESM only |
| Peers | `@perrylink/dsh-research-core ^0.1.0`, `@deepseek-ai/cordis ^4.0.5-alpha.1`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| Runtime dependencies | **zero** (PNG via `node:zlib`) |

```sh
dsh plugin --profile <name> add @perrylink/dsh-research-core dsh-image-integrity
dsh --profile <name> --dump-config | grep dsh-image-integrity
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` mounts nothing |
| `root` | `.image-integrity` | store/record root |
| `workspaceRoot` | `process.cwd()` | paths must resolve inside it |
| `maxBytes` | `20971520` | file cap (fails, never truncates) |
| `maxPixels` | `4000000` | decoded pixel cap |
| `persist` | `true` | store images as REP evidence + record |
| `blockSize` / `maxShiftBits` | `16` / `6` | block side (2–256); bit tolerance (0–blockSize²) |
| `minVariance` / `nccThreshold` | `6` / `0.97` | texture floor; NCC confirmation |

## Security boundaries

- Read-only on images; writes only under `root`.
- `realpath` containment rejects symlink escapes.
- Hard caps on bytes and pixels; the pixel cap is checked from the IHDR
  **before** inflation, and `inflateSync` is bounded by the expected output
  size. Failures are loud.
- Per-call thresholds are validated (`blockSize` 2–256, `maxShiftBits`
  0–blockSize², NCC 0–1); an invalid threshold is `INVALID_INPUT`, not a crash.
- PNG parser bounds-checks every chunk; unsupported formats are rejected, not guessed.

## Evaluation

**21 tests**: PNG round-trip, non-PNG / 16-bit / truncated rejection, pixel-cap rejection from the IHDR before inflation, Hamming and NCC primitives, duplicate block detection, horizontal mirror detection, flat-image and gradient false-positive controls, small-image effective block size, pair matching, dimension-mismatch refusal, runtime (valid REP record, two snapshots per comparison, traversal/JPEG/byte-and-pixel oversize rejection, invalid threshold rejection), tools (schemas, check→report, compare, malformed report, failure branch), package contract.

**Benchmark status: not yet claimed.** The planned `dsh-research-bench` set is 100 synthetic PNG pairs (duplicate / mirrored / unrelated / hard negative). Until that set is frozen and scored, the unit fixtures above are the only evidence, and the README says so.

## Known limitations (v0.1)

- PNG-only; no JPEG/WebP/TIFF.
- No scaling/rotation/recompression robustness.
- Block grid is axis-aligned; a duplicated region shifted by a few pixels can be missed.
- No colour-channel or metadata (EXIF) analysis.

## License

Apache-2.0. No third-party runtime code.
