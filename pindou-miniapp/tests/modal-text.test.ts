import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'vitest'
import { src } from './helpers/load'

// 微信 showModal 的按钮文字最多 4 个字：超了在真机上可能截断，或整个弹窗调不起来，
// 弹不出确认框，后面的操作就做不下去。2026-10-06 收货入库「换成新条码」（5 个字）就是这样漏过去的：
// 单元测试里 Taro 是假的，不检查长度。这里把源码里写死的按钮文字都扫一遍。

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

test('弹窗按钮文字（confirmText、cancelText）不超过 4 个字', () => {
  const tooLong: string[] = []
  let seen = 0
  for (const file of sources(src)) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(confirmText|cancelText)\s*:\s*(['"`])([^'"`]*)\2/g)) {
      seen++
      const label = match[3]
      if ([...label].length > 4) tooLong.push(`${path.relative(src, file)}：${match[1]}「${label}」`)
    }
  }
  assert.ok(seen > 5, '一个按钮文字都没扫到，正则或目录不对')
  assert.deepEqual(tooLong, [], `微信弹窗按钮文字最多 4 个字：\n${tooLong.join('\n')}`)
})
