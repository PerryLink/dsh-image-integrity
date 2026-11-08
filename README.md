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

**23 tests**: PNG round-trip, non-PNG / 16-bit / truncated rejection, pixel-cap rejection from the IHDR before inflation (configured and default), Hamming and NCC primitives, duplicate block detection, horizontal mirror detection, flat-image and gradient false-positive controls, small-image effective block size, pair matching, dimension-mismatch refusal, runtime (valid REP record, two snapshots per comparison, traversal/JPEG/byte-and-pixel oversize rejection, invalid threshold rejection), tools (schemas, check→report, compare, malformed report, failure branch), mount contract (disabled mounts nothing, enabled registers three unique tools), package contract.

**Benchmark — 100 synthetic pairs.** `pnpm run bench:images` scores the plugin against the frozen set (dataset version 0.1.0) in the companion [`dsh-research-bench`](https://github.com/PerryLink/dsh-research-bench) repository (`data/images`): 25 duplicate + 25 flip + 25 unrelated + 25 hard-negative pairs of 64×64 8-bit grey PNGs, fixed seed, with positives copying grid-aligned 16×16 blocks. The adapter runs against the built `lib/`, writes [`bench/results-images.json`](bench/results-images.json) with no timestamps (rerunning on the same data is byte-identical), and reads a sibling `../dsh-research-bench` checkout by default. Set `BENCH_DIR` or pass `node bench/run-images.mjs --data <dir>` for another location.

| Metric (50 manipulated / 50 clean) | Value |
|---|---|
| Manipulated precision | 1.0000 |
| Manipulated recall | 1.0000 |
| Manipulated F1 | 1.0000 |
| False-positive rate (unrelated + hard-negative) | 0.0000 |
| Subtype recall — duplicate | 1.0000 |
| Subtype recall — flip (horizontal 13 / vertical 12) | 1.0000 |

Confusion: TP 50, FP 0, TN 50, FN 0; no pair was misclassified. Per-category accuracy is 1.0000 in all four categories (25/25 each). Scope: the positives copy **grid-aligned** 16×16 blocks, i.e. the detector's own unit; sub-grid shifts, JPEG recompression, scaling and rotation are outside this set and remain documented limitations. These are synthetic numbers on a frozen fixture, not a claim about how often real figures reuse panels. The dataset and generator live in the companion repository and are not published with this package.

## Known limitations (v0.1)

- PNG-only; no JPEG/WebP/TIFF.
- No scaling/rotation/recompression robustness.
- Block grid is axis-aligned; a duplicated region shifted by a few pixels can be missed.
- No colour-channel or metadata (EXIF) analysis.

## License

Apache-2.0. No third-party runtime code.
