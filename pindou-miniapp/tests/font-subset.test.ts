import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { root } from './helpers/load'

// 子集字体只包含打包时列举的字符；标题新增了字却没重新生成子集，
// 运行时会静默回落成黑体且不报错。这里把它变成构建期失败。
test('display subset covers every character used in page titles', async () => {
  const { charset } = await import('../scripts/build-font-subset.mjs')
  const required = charset()
  const shipped = new Set(readFileSync(`${root}src/assets/fonts/examplebrand-display.charset.txt`, 'utf8'))
  const missing = [...required].filter((c) => !shipped.has(c))
  assert.deepStrictEqual(
    missing,
    [],
    `子集缺少这些字符：${missing.join('')}\n请运行 node scripts/build-font-subset.mjs 重新生成。`,
  )
})
