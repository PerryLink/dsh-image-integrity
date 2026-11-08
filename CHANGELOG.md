# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-08

First release: block-level image reuse detection.

### Added

- `image_check`: duplicated and mirrored 16×16 textured blocks inside one PNG,
  with Hamming/NCC scores.
- `image_compare`: shared duplicated/mirrored blocks between two PNGs; a
  dimension mismatch is reported, never resized.
- `image_report`: Markdown + SARIF 2.1.0.
- Zero-dependency PNG decoder (8-bit, non-interlaced, grey/RGB/RGBA) with
  bounds-checked chunks, plus a greyscale encoder used by tests.
- False-positive controls: flat blocks and blocks that are close to a fitted
  plane are ignored, so smooth gradients do not read as duplicates.
- REP v1 integration: image bytes become immutable snapshots with figure
  anchors (ordinal included), one check per matched region, and a valid record.
- 18 tests.

### Notes

- Finds reused pixels, not manipulation intent; repeated controls are normal.
- JPEG/WebP/TIFF are not decoded in v0.1 and are rejected explicitly.
- The 100-pair benchmark is not yet frozen; no benchmark numbers are claimed.
