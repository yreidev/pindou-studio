#!/usr/bin/env node
// 按微信的分包规则量一遍产物：每个文件归给「路径前缀最长的那个分包 root」，
// 其余算主包。微信的限制是**主包 ≤ 2 MB、单个分包 ≤ 2 MB、整包 ≤ 20 MB**，
// 所以只看总大小是看不出问题的，必须按包分开量。
//
// 用法：node scripts/package-size.mjs [dist目录，默认 dist] [--baseline 另一个dist]
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const MAIN_LIMIT = 2 * 1024 * 1024
const TOTAL_LIMIT = 20 * 1024 * 1024

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function measure(dist) {
  const appJson = JSON.parse(fs.readFileSync(path.join(dist, 'app.json'), 'utf8'))
  // 长前缀优先：pages/staff 要先于 pages 匹配
  const roots = (appJson.subPackages || appJson.subpackages || [])
    .map((s) => s.root.replace(/\/?$/, '/'))
    .sort((a, b) => b.length - a.length)
  const buckets = new Map([['（主包）', []], ...roots.map((r) => [r, []])])
  for (const file of walk(dist)) {
    const rel = path.relative(dist, file)
    const root = roots.find((r) => rel.startsWith(r)) || '（主包）'
    buckets.get(root).push([rel, fs.statSync(file).size])
  }
  const sizes = new Map([...buckets].map(([k, v]) => [k, v.reduce((a, [, s]) => a + s, 0)]))
  return { sizes, buckets }
}

const fmt = (n) => `${(n / 1024).toFixed(1).padStart(8)} KB`
const sign = (n) => (n > 0 ? `+${(n / 1024).toFixed(1)} KB` : `${(n / 1024).toFixed(1)} KB`)

const args = process.argv.slice(2)
const dist = args.find((a) => !a.startsWith('--')) || 'dist'
const baselineDir = args.includes('--baseline') ? args[args.indexOf('--baseline') + 1] : null
const { sizes, buckets } = measure(dist)
const base = baselineDir ? measure(baselineDir).sizes : null

console.log(`产物：${dist}${baselineDir ? `   基线：${baselineDir}` : ''}\n`)
let total = 0
for (const [name, size] of sizes) {
  total += size
  const delta = base ? `   ${sign(size - (base.get(name) ?? 0)).padStart(10)}` : ''
  const over = name === '（主包）' && size > MAIN_LIMIT ? '  ← 超 2 MB 主包上限！' : ''
  console.log(`${name.padEnd(18)} ${fmt(size)}${delta}${over}`)
}
const baseTotal = base ? [...base.values()].reduce((a, b) => a + b, 0) : 0
console.log(`${'合计'.padEnd(17)} ${fmt(total)}${base ? `   ${sign(total - baseTotal).padStart(10)}` : ''}`)
console.log(
  `\n主包占上限 ${((sizes.get('（主包）') / MAIN_LIMIT) * 100).toFixed(1)}%，整包占上限 ${((total / TOTAL_LIMIT) * 100).toFixed(1)}%`,
)

if (args.includes('--top')) {
  console.log('\n主包最大的 15 个文件：')
  for (const [rel, size] of buckets
    .get('（主包）')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15))
    console.log(`  ${fmt(size)}  ${rel}`)
}

// 打出**产物里真正内置的版本号**，和 package.json 比对。
//
// ★ 传包前我总要核这张体积表，版本号放在这里就是顺带一眼的事。2026-09-20 业主手机上
//   跑着缓存的旧分包，排查时没有任何权威数字可对 —— 体积表能查出「编的是旧代码」，
//   却查不出「传的是哪一版」。
// ★★ 版本常量被打进**共享 chunk**（common.js），不在各页面的 js 里。第一次写检查时
//    只翻了页面文件，得出「没注入」的假警报。所以这里整个 dist 找。
const declared = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const built = walk(dist)
  .filter((file) => file.endsWith('.js'))
  .some((file) => fs.readFileSync(file, 'utf8').includes(`"${declared}"`))
console.log(
  built
    ? `\n内置版本号 ${declared}（与 package.json 一致，上传请用 -v ${declared}）`
    : `\n⚠ 产物里找不到版本号 ${declared} —— 构建常量没注入，页脚会显示「开发版」`,
)
