import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'vitest'
import { root, src } from './helpers/load'

const SRC = src
const DIST = path.resolve(root, 'dist')

function walk(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(tsx?|json)$/.test(entry.name)) out.push(full)
  }
  return out
}

// 一个分包里的页面，不能引用另一个分包里的资源。
//
// ★★ 2026-09-19 踩到：座位底图原本只有顾客预约页用，跟着进了 pages/customer 分包。
//    布局固定化之后员工端桌位页也要用同一张图画热区（店员看到的位置就是顾客看到的位置），
//    我顺手写了个 src="/assets/seatmap/plan.jpg" —— 路径是旧的，图根本不存在。
//    真机上表现为：热区浮在一片空白上，**不报错**。
//
//    就算把路径改对成 /pages/customer/assets/seatmap/plan.jpg 也仍然是错的：
//    分包的文件要等用户第一次进入**那个分包**才下载得到，员工分包的页面读顾客分包的图，
//    在顾客还没进过预约页时就是白图。两端共用的资源必须放主包。
//
// ★ 这条只查源码里的字面量路径，运行时拼出来的路径查不到 ——
//   那类由 tests/upload-packing.test.ts 的「每个资源路径都要在 dist 里存在」兜住。
test('no page references an asset that lives in a different subpackage', (context) => {
  if (!fs.existsSync(path.join(DIST, 'app.json'))) {
    context.skip('dist 还没构建')
    return
  }
  const app = JSON.parse(fs.readFileSync(path.join(DIST, 'app.json'), 'utf8'))
  const roots = (app.subPackages || []).map((sub) => sub.root.replace(/\/?$/, '/'))
  const ownerOf = (p: string) => roots.find((root) => p.replace(/^\//, '').startsWith(root)) || ''

  const bad: string[] = []
  for (const file of walk(SRC)) {
    // 这个文件属于哪个分包（按它在 src/pages 下的位置）
    const rel = path.relative(SRC, file).replace(/\\/g, '/')
    const owner = ownerOf(rel)
    const body = fs.readFileSync(file, 'utf8')
    for (const m of body.matchAll(/["'`](\/[\w./-]+\.(?:jpg|jpeg|png|gif|svg|webp))["'`]/g)) {
      const asset = m[1]
      const assetOwner = ownerOf(asset)
      if (assetOwner && assetOwner !== owner) {
        bad.push(`${rel} 引用了 ${asset}（属于分包 ${assetOwner}）`)
      }
      if (!fs.existsSync(path.join(DIST, asset.replace(/^\//, '')))) {
        bad.push(`${rel} 引用的 ${asset} 在构建产物里不存在`)
      }
    }
  }
  assert.deepEqual(
    bad,
    [],
    '分包之间不能互相引用资源，两端共用的要放主包。真机上表现为白图且不报错：\n  ' + bad.join('\n  '),
  )
})
