# dsh-image-integrity

**这张子图是不是被复用了 —— 原地重复，还是从另一张图镜像粘贴过来？**

*零依赖 PNG 解码、带 NCC 确认的均值阈值块指纹、重复/镜像区域报告、REP 证据与 SARIF。它找的是被复用的像素，而不是操纵意图。*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()

[English](README.md) · 简体中文

---

## 它做什么

- **`image_check`** —— 在单张图片内找出出现两次（或以镜像形式出现）的纹理块。
- **`image_compare`** —— 找出两张图片之间共有的块，包括镜像副本。
- **`image_report`** —— Markdown + SARIF 2.1.0，每个匹配区域一条 warning，附坐标、汉明距离与 NCC。

工作原理：解码 PNG → 亮度 → 16×16 块 → 均值阈值位模式（可抵抗亮度偏移）+ 零均值 NCC 确认。平坦**或接近拟合平面**的块会被跳过，因此平滑渐变不会被报成“重复”。

## 它不做什么

- **不支持 JPEG。** 只解码 8 位非隔行 PNG（灰度/RGB/RGBA）。JPEG/16 位/隔行 PNG 会以明确的错误码拒绝 —— 不会静默返回垃圾结果。
- **不做对齐。** 图片尺寸必须完全相同；尺寸不一致会报告，绝不缩放。
- **不抗模糊/压缩。** 经 JPEG 重压缩、缩放、旋转或拼接混合后，通常就检测不出来了。
- **不指控学术不端。** 重复的对照图、比例尺、图标与背景纹理都是合法的共享块。报告会说明这一点。
- **没有 GUI，也不上传。** 只处理本地字节。

## 工具

### `image_check`

`{ path, persist?, blockSize?, maxShiftBits?, minVariance?, nccThreshold? }` → `{ ok, analysis, evidenceId?, recordPath? }`。

### `image_compare`

`{ pathA, pathB, persist?, ...thresholds }` → `{ ok, analysis, evidenceId?, recordPath? }`。

### `image_report`

`{ analysis, imageId? }` → `{ ok, markdown, sarif }`。

### 错误码

`INVALID_INPUT` · `NOT_FOUND` · `PATH_ESCAPE` · `NOT_A_FILE` · `TOO_LARGE` · `UNSUPPORTED_IMAGE` · `STORE_ERROR`

## 兼容性与安装

| | |
|---|---|
| DeepSeek Harness | **`dsh-v0.2.1-rc.5`**（2026-11-08 实测）；peer `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0`（实测 `24.22.1`），仅 ESM |
| Peer 依赖 | `@perrylink/dsh-research-core ^0.1.0`、`@deepseek-ai/cordis ^4.0.5-alpha.1`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| 运行时依赖 | **零**（PNG 解码通过 `node:zlib`） |

```sh
dsh plugin --profile <name> add @perrylink/dsh-research-core dsh-image-integrity
dsh --profile <name> --dump-config | grep dsh-image-integrity
```

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时不挂载任何内容 |
| `root` | `.image-integrity` | 存储/记录的根目录 |
| `workspaceRoot` | `process.cwd()` | 路径必须解析到该目录内 |
| `maxBytes` | `20971520` | 文件大小上限（超限即失败，绝不截断） |
| `maxPixels` | `4000000` | 解码后的像素数上限 |
| `persist` | `true` | 将图片存为 REP 证据并写入记录 |
| `blockSize` / `maxShiftBits` | `16` / `6` | 块边长（2–256）；位容差（0–blockSize²） |
| `minVariance` / `nccThreshold` | `6` / `0.97` | 纹理下限；NCC 确认阈值 |

## 安全边界

- 对图片只读；只在 `root` 下写入。
- `realpath` 路径包含校验会拒绝符号链接逃逸。
- 对字节数和像素数设硬上限；像素上限在解压**之前**就根据 IHDR 检查，`inflateSync` 也按预期输出大小加以限制。失败会显式报错。
- 每次调用的阈值都会校验（`blockSize` 2–256，`maxShiftBits` 0–blockSize²，NCC 0–1）；非法阈值返回 `INVALID_INPUT`，不会崩溃。
- PNG 解析器对每个 chunk 做边界检查；不支持的格式直接拒绝，不做猜测。

## 评测

**22 个测试**：PNG 往返、非 PNG / 16 位 / 截断文件拒绝、解压前依据 IHDR 拒绝超像素上限（配置值与默认值）、汉明距离与 NCC 基础函数、重复块检测、水平镜像检测、平坦图与渐变图的误报控制、小图的有效块大小、成对匹配、尺寸不一致时拒绝、runtime（合法 REP 记录、每次比较生成两份快照、路径遍历/JPEG/字节与像素超限拒绝、非法阈值拒绝）、tools（schema、check→report、compare、格式错误的报告、失败分支）、包契约。

**基准测试状态：尚未声称。** 计划中的 `dsh-research-bench` 数据集是 100 对合成 PNG（重复 / 镜像 / 无关 / 困难负样本）。在该数据集冻结并评分之前，上述单元 fixture 是唯一的证据，README 也如实说明这一点。

## 已知限制（v0.1）

- 仅支持 PNG；不支持 JPEG/WebP/TIFF。
- 不抗缩放/旋转/重压缩。
- 块网格与坐标轴对齐；偏移几个像素的重复区域可能被漏掉。
- 不分析颜色通道或元数据（EXIF）。

## 许可

Apache-2.0。运行时不含第三方代码。
