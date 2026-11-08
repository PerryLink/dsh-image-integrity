#!/usr/bin/env node
// Score dsh-image-integrity against the frozen synthetic image-reuse set.
//
// The adapter is deliberately thin: decode both PNGs, call compareImages with
// the plugin defaults, predict `manipulated = matches.length > 0`, and take the
// first match's kind. It never reads or writes the benchmark labels into the
// prediction path; labels are only used after the fact to score.
//
// Usage: node bench/run-images.mjs [--data <dir>]
// Default data: ../dsh-research-bench/data/images (sibling checkout). `BENCH_DIR`
// is honoured like the other adapters in dsh-research-bench: it may point at the
// benchmark repository root or directly at its data/images directory.
//
// Output: bench/results-images.json (no timestamps; byte-identical reruns on
// the same data) plus a markdown summary on stdout.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultDataDir = path.resolve(root, '..', 'dsh-research-bench', 'data', 'images')

const fail = message => {
  console.error(`bench:images: ${message}`)
  process.exit(1)
}

const CATEGORIES = ['duplicate', 'flip', 'unrelated', 'hard-negative']
const FLIP_KINDS = ['horizontal-flip', 'vertical-flip']
const POSITIVE_KINDS = ['duplicate', ...FLIP_KINDS]
const KINDS = [...POSITIVE_KINDS, null]
const LOGICAL_SOURCE = 'dsh-research-bench/data/images'

// ── arguments ───────────────────────────────────────────────────────────────

let dataDir
if (process.env.DSH_IMAGE_BENCH_DATA !== undefined) {
  dataDir = path.resolve(process.env.DSH_IMAGE_BENCH_DATA)
} else if (process.env.BENCH_DIR !== undefined) {
  const benchRoot = path.resolve(process.env.BENCH_DIR)
  const nested = path.join(benchRoot, 'data', 'images')
  dataDir = existsSync(path.join(nested, 'cases.jsonl')) ? nested : benchRoot
} else {
  dataDir = defaultDataDir
}
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index]
  if (argument === '--help' || argument === '-h') {
    console.log('usage: node bench/run-images.mjs [--data <dir>]')
    process.exit(0)
  }
  if (argument === '--data') {
    const value = argv[index + 1]
    if (value === undefined) fail('--data needs a directory')
    dataDir = path.resolve(value)
    index += 1
    continue
  }
  fail(`unknown argument ${argument}`)
}

// ── load the built plugin ───────────────────────────────────────────────────

const moduleUrl = relative => pathToFileURL(path.join(root, relative)).href
let decodePng
let compareImages
let resolveImageOptions
try {
  ;({ decodePng } = await import(moduleUrl('lib/png.js')))
  ;({ compareImages, resolveImageOptions } = await import(moduleUrl('lib/analyze.js')))
} catch (error) {
  fail(`cannot load lib/*.js (${error.message}); run \`pnpm run build\` first`)
}

// ── read and check the frozen data ──────────────────────────────────────────

const casesFile = path.join(dataDir, 'cases.jsonl')
const summaryFile = path.join(dataDir, 'SUMMARY.json')
if (!existsSync(casesFile)) fail(`missing ${casesFile}; pass --data <dir> or check out dsh-research-bench as a sibling`)
if (!existsSync(summaryFile)) fail(`missing ${summaryFile}`)
const casesBytes = readFileSync(casesFile)
let summary
try {
  summary = JSON.parse(readFileSync(summaryFile, 'utf8'))
} catch (error) {
  fail(`${summaryFile}: ${error.message}`)
}
const cases = casesBytes
  .toString('utf8')
  .split('\n')
  .filter(line => line.trim() !== '')
  .map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      fail(`cases.jsonl:${index + 1}: ${error.message}`)
    }
  })

if (summary.dataset !== 'images') fail(`SUMMARY.dataset is ${String(summary.dataset)}, expected "images"`)
if (summary.total !== cases.length) fail(`SUMMARY.total is ${String(summary.total)} but cases.jsonl has ${cases.length} cases`)

const ids = new Set()
for (const [index, item] of cases.entries()) {
  const where = `cases.jsonl:${index + 1}`
  if (typeof item.id !== 'string' || !/^img-[0-9]{4}$/u.test(item.id)) fail(`${where}: bad id ${String(item.id)}`)
  if (ids.has(item.id)) fail(`${where}: duplicate id ${item.id}`)
  ids.add(item.id)
  if (!CATEGORIES.includes(item.category)) fail(`${where}: unknown category ${String(item.category)}`)
  if (typeof item.description !== 'string' || item.description === '') fail(`${where}: description missing`)
  if (typeof item.expected !== 'object' || item.expected === null || Array.isArray(item.expected)) fail(`${where}: expected missing`)
  if (typeof item.expected.manipulated !== 'boolean') fail(`${where}: expected.manipulated must be boolean`)
  if (!KINDS.includes(item.expected.kind)) fail(`${where}: unknown expected.kind ${String(item.expected.kind)}`)
  const positive = item.category === 'duplicate' || item.category === 'flip'
  if (item.expected.manipulated !== positive) fail(`${where}: category ${item.category} contradicts expected.manipulated`)
  if (positive && !POSITIVE_KINDS.includes(item.expected.kind)) fail(`${where}: ${item.category} needs a positive kind`)
  if (!positive && item.expected.kind !== null) fail(`${where}: a negative case needs kind null`)
  if (item.category === 'duplicate' && item.expected.kind !== 'duplicate') fail(`${where}: duplicate cases must be labelled duplicate`)
  if (item.category === 'flip' && !FLIP_KINDS.includes(item.expected.kind)) fail(`${where}: flip cases must be labelled horizontal-flip or vertical-flip`)
  for (const name of ['a.png', 'b.png']) {
    if (!existsSync(path.join(dataDir, 'cases', item.id, name))) fail(`${where}: missing cases/${item.id}/${name}`)
  }
}

// ── score ───────────────────────────────────────────────────────────────────

const thresholds = resolveImageOptions()
const ratio = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator)

let tp = 0
let fp = 0
let tn = 0
let fn = 0
const perCategory = Object.fromEntries(
  CATEGORIES.map(category => [category, { total: 0, correct: 0, manipulated: 0, kinds: { duplicate: 0, 'horizontal-flip': 0, 'vertical-flip': 0, none: 0 } }]),
)
const misclassified = []
let positivePairs = 0
let matchedPairs = 0
let exactlyOneMatchPairs = 0
let maxMatchesPerPositive = 0
let minFirstMatchNcc = Number.POSITIVE_INFINITY
let maxFirstMatchHamming = 0

for (const item of cases) {
  const a = decodePng(readFileSync(path.join(dataDir, 'cases', item.id, 'a.png')))
  const b = decodePng(readFileSync(path.join(dataDir, 'cases', item.id, 'b.png')))
  const result = compareImages(a, b)
  const manipulated = result.matches.length > 0
  const kind = manipulated ? result.matches[0].kind : null

  if (item.expected.manipulated) {
    positivePairs += 1
    if (manipulated) {
      matchedPairs += 1
      maxMatchesPerPositive = Math.max(maxMatchesPerPositive, result.matches.length)
      if (result.matches.length === 1) exactlyOneMatchPairs += 1
      minFirstMatchNcc = Math.min(minFirstMatchNcc, result.matches[0].ncc)
      maxFirstMatchHamming = Math.max(maxFirstMatchHamming, result.matches[0].hamming)
    }
  }

  const predictedKey = kind ?? 'none'
  const bucket = perCategory[item.category]
  bucket.total += 1
  bucket.manipulated += manipulated ? 1 : 0
  bucket.kinds[predictedKey] += 1

  const correct = manipulated === item.expected.manipulated && kind === item.expected.kind
  if (correct) bucket.correct += 1

  if (item.expected.manipulated && manipulated) tp += 1
  else if (item.expected.manipulated && !manipulated) fn += 1
  else if (!item.expected.manipulated && manipulated) fp += 1
  else tn += 1

  if (!correct) {
    misclassified.push({
      id: item.id,
      category: item.category,
      expected: { manipulated: item.expected.manipulated, kind: item.expected.kind },
      predicted: { manipulated, kind },
      matches: result.matches.length,
      firstMatch: result.matches.length === 0 ? null : { kind: result.matches[0].kind, hamming: result.matches[0].hamming, ncc: result.matches[0].ncc },
    })
  }
}

for (const category of CATEGORIES) {
  const bucket = perCategory[category]
  bucket.accuracy = ratio(bucket.correct, bucket.total)
}

const duplicateCases = cases.filter(item => item.category === 'duplicate')
const flipCases = cases.filter(item => item.category === 'flip')
const horizontalCases = flipCases.filter(item => item.expected.kind === 'horizontal-flip')
const verticalCases = flipCases.filter(item => item.expected.kind === 'vertical-flip')

const precision = ratio(tp, tp + fp)
const recall = ratio(tp, tp + fn)
const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall)
const falsePositiveRate = ratio(fp, fp + tn)

// The per-category kind buckets accumulated while scoring give the subtype
// recalls without a second decode pass: only cases of the named category are
// counted, so a flip case predicted "duplicate" counts against both axes.
const subtypeRecall = {
  duplicate: ratio(perCategory.duplicate.kinds.duplicate, duplicateCases.length),
  flip: ratio(perCategory.flip.kinds['horizontal-flip'] + perCategory.flip.kinds['vertical-flip'], flipCases.length),
  'horizontal-flip': ratio(perCategory.flip.kinds['horizontal-flip'], horizontalCases.length),
  'vertical-flip': ratio(perCategory.flip.kinds['vertical-flip'], verticalCases.length),
}

const results = {
  dataset: 'images',
  datasetVersion: summary.version,
  source: LOGICAL_SOURCE,
  casesSha256: createHash('sha256').update(casesBytes).digest('hex'),
  cases: cases.length,
  thresholds,
  rule: 'manipulated = compareImages(a, b).matches.length > 0; kind = matches[0].kind, null when no match',
  counts: { tp, fp, tn, fn },
  metrics: {
    precision,
    recall,
    f1,
    falsePositiveRate,
    accuracy: ratio(tp + tn, cases.length),
    subtypeRecall,
  },
  perCategory,
  evidence: {
    positivePairs,
    matchedPairs,
    exactlyOneMatchPairs,
    maxMatchesPerPositive,
    minFirstMatchNcc: Number.isFinite(minFirstMatchNcc) ? minFirstMatchNcc : null,
    maxFirstMatchHamming: positivePairs === 0 ? null : maxFirstMatchHamming,
  },
  confusion: {
    labels: { positive: 'manipulated', negative: 'not-manipulated' },
    matrix: { tp, fp, fn, tn },
    misclassified,
  },
}

writeFileSync(path.join(root, 'bench', 'results-images.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8')

// ── markdown summary ────────────────────────────────────────────────────────

const show = value => (value === null ? 'n/a' : value.toFixed(4))
const lines = [
  `# Image-reuse benchmark — ${cases.length} synthetic pairs`,
  '',
  `Dataset: \`${LOGICAL_SOURCE}\` (version ${summary.version}, cases.jsonl sha256 \`${results.casesSha256}\`)`,
  `Thresholds: blockSize=${thresholds.blockSize}, maxShiftBits=${thresholds.maxShiftBits}, minVariance=${thresholds.minVariance}, nccThreshold=${thresholds.nccThreshold}`,
  '',
  '| Metric | Value |',
  '| --- | --- |',
  `| Manipulated precision | ${show(precision)} |`,
  `| Manipulated recall | ${show(recall)} |`,
  `| Manipulated F1 | ${show(f1)} |`,
  `| False-positive rate (unrelated + hard-negative) | ${show(falsePositiveRate)} |`,
  `| Subtype recall — duplicate | ${show(subtypeRecall.duplicate)} |`,
  `| Subtype recall — flip (both axes) | ${show(subtypeRecall.flip)} |`,
  `| Subtype recall — horizontal-flip | ${show(subtypeRecall['horizontal-flip'])} |`,
  `| Subtype recall — vertical-flip | ${show(subtypeRecall['vertical-flip'])} |`,
  '',
  '| Category | Pairs | Full-label accuracy | Predicted manipulated |',
  '| --- | --- | --- | --- |',
  ...CATEGORIES.map(category => {
    const bucket = perCategory[category]
    return `| ${category} | ${bucket.total} | ${show(bucket.accuracy)} | ${bucket.manipulated} |`
  }),
  '',
  '| Expected \\ Predicted | manipulated | not-manipulated |',
  '| --- | --- | --- |',
  `| manipulated | ${tp} (TP) | ${fn} (FN) |`,
  `| not-manipulated | ${fp} (FP) | ${tn} (TN) |`,
  '',
]
if (misclassified.length > 0) {
  lines.push('Misclassified pairs:', '', '| id | category | expected kind | predicted kind | matches |', '| --- | --- | --- | --- | --- |')
  for (const item of misclassified) {
    lines.push(`| ${item.id} | ${item.category} | ${item.expected.kind ?? 'none'} | ${item.predicted.kind ?? 'none'} | ${item.matches} |`)
  }
} else {
  lines.push('Misclassified pairs: none.')
}
console.log(lines.join('\n'))
