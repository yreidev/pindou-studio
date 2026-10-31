import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
import { make, prepare, styleSettings, styleTone, type Style } from '../src/services/maker/generate'
import { fullPlacement } from '../src/services/maker/image'
import { palette } from '../src/services/maker/palettes'
import { defaultSettings } from '../src/services/maker/session'
import { readPng, score, type Score } from './helpers/bead-score'

// 转图基准（docs/plan-bead-maker.md 第 6 节）：20 张公有领域 / CC0 的照片（来源、作者、许可见 fixtures/photos/sources.json），
// 按顾客的默认设置转图、打分，和 fixtures/photos/baseline.json 比——改算法只许变好、不许变差。
// 看前后几项的数：npx vitest run tests/maker-benchmark.test.ts --reporter=verbose。
// 确实变好了，或者有意取舍时：UPDATE_BENCHMARK=1 npx vitest run tests/maker-benchmark.test.ts 重写基准，提交时写清哪几项变了。

type Source = { id: string; kind: string }
type Baseline = Record<string, Record<string, Score>>

const dir = fileURLToPath(new URL('./fixtures/photos/', import.meta.url))
const sources = JSON.parse(readFileSync(`${dir}sources.json`, 'utf8')) as Source[]
const baselinePath = `${dir}baseline.json`
const defaults = defaultSettings()
// 颜色最多、清掉零星按各风格自己的一套（styleSettings）；2026-10-21 起默认是写实，卡通、原样照旧比
const cases: { name: string; cols: number; style: Style }[] = [
  { name: `${defaults.cols} 格写实（默认）`, cols: defaults.cols, style: 'real' },
  { name: `${defaults.cols} 格卡通`, cols: defaults.cols, style: 'cartoon' },
  { name: '29 格原样', cols: 29, style: 'plain' },
]

const round = (s: Score): Score => ({
  colorError: Math.round(s.colorError * 100) / 100,
  strays: Math.round(s.strays * 10) / 10,
  lineKept: s.lineKept === null ? null : Math.round(s.lineKept * 1000) / 1000,
  colors: s.colors,
})

function totals(scores: Record<string, Score>) {
  const list = Object.values(scores)
  const lines = list.filter((s) => s.lineKept !== null)
  return {
    colorError: list.reduce((n, s) => n + s.colorError, 0) / list.length,
    strays: list.reduce((n, s) => n + s.strays, 0) / list.length,
    lineKept: lines.reduce((n, s) => n + s.lineKept!, 0) / lines.length,
  }
}

test('转图基准：20 张照片按默认设置转图，颜色差、零星单颗、细线保留都不比基准差', async () => {
  const p = palette(defaults.paletteId)!
  const now: Baseline = {}
  for (const c of cases) {
    now[c.name] = {}
    for (const s of sources) {
      const src = readPng(`${dir}${s.id}.png`)
      const view = prepare(src, fullPlacement(), styleTone(c.style))
      const g = await make(view, {
        cols: c.cols,
        palette: p,
        ...styleSettings(c.style),
        style: c.style,
      })
      now[c.name][s.id] = round(score(src, g, p))
    }
  }

  if (process.env.UPDATE_BENCHMARK) {
    writeFileSync(baselinePath, JSON.stringify(now, null, 2) + '\n')
    return
  }
  const before = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline
  const problems: string[] = []
  for (const c of cases) {
    const a = totals(before[c.name]),
      b = totals(now[c.name])
    console.log(
      `${c.name}：颜色差 ${a.colorError.toFixed(2)} → ${b.colorError.toFixed(2)}，` +
        `零星单颗 ${a.strays.toFixed(1)}‰ → ${b.strays.toFixed(1)}‰，细线保留 ${(a.lineKept * 100).toFixed(1)}% → ${(b.lineKept * 100).toFixed(1)}%`,
    )
    // 整体：平均值不许变差（留一点舍入的余地）
    if (b.colorError > a.colorError + 0.02) problems.push(`${c.name} 平均颜色差变大`)
    if (b.strays > a.strays + 0.2) problems.push(`${c.name} 平均零星单颗变多`)
    if (b.lineKept < a.lineKept - 0.003) problems.push(`${c.name} 平均细线保留变少`)
    // 单张：允许小的此消彼长，明显变差的单独报出来
    for (const s of sources) {
      const x = before[c.name][s.id],
        y = now[c.name][s.id]
      if (!x) {
        problems.push(`${c.name} ${s.id} 没有基准`)
        continue
      }
      if (y.colorError > x.colorError + 0.5) problems.push(`${c.name} ${s.id} 颜色差 ${x.colorError} → ${y.colorError}`)
      if (y.strays > x.strays + 5) problems.push(`${c.name} ${s.id} 零星单颗 ${x.strays}‰ → ${y.strays}‰`)
      if (x.lineKept !== null && y.lineKept !== null && y.lineKept < x.lineKept - 0.08)
        problems.push(`${c.name} ${s.id} 细线保留 ${x.lineKept} → ${y.lineKept}`)
    }
  }
  if (problems.length) throw new Error(`转图比基准差：\n${problems.join('\n')}`)
}, 120_000)
