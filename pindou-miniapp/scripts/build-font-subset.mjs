// 生成品牌标题字体子集，并内联为 base64 @font-face。
// 字体：霞鹜文楷 Light（LXGW WenKai，SIL OFL 1.1，可商用）。楷体的手写感贴合「手作研究室」定位。
//   上游 https://github.com/lxgw/LxgwWenKai/releases/download/v1.520/LXGWWenKai-Light.ttf
//   源文件 26MB，不入库；只提交生成出的子集。重新生成时用 EXAMPLE_DISPLAY_SRC 指向本地副本。
// 字符集来源：Screen/StaffScreen 的标题文案 + 品牌文案 + 数字英文标点。
// 小程序 WXSS 不支持远程 @font-face，只支持 base64，因此直接内联。
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'

const SRC_DIR = 'src'
const SRC = process.env.EXAMPLE_DISPLAY_SRC || `${process.env.HOME}/.local/share/fonts-src/LXGWWenKai-Light.ttf`
const WOFF2 = 'src/assets/fonts/examplebrand-display.woff2'
const SCSS = 'src/styles/_font.scss'
const CHARSET = 'src/assets/fonts/examplebrand-display.charset.txt'

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.tsx') || p.endsWith('.ts') ? [p] : []
  })
}

// 抓 <Screen|StaffScreen ... title=<表达式>，取表达式里的字面量
export function titleStrings() {
  const out = new Set()
  for (const file of walk(SRC_DIR)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/<(Screen|StaffScreen)\b/g)) {
      // 取该标签内的属性区
      const end = text.indexOf('>', m.index)
      const attrs = text.slice(m.index, end === -1 ? undefined : end)
      const t = attrs.match(/title=(?:(['"])(.*?)\1|\{([^}]*(?:\{[^}]*\}[^}]*)*)\})/)
      if (!t) continue
      const expr = t[2] !== undefined ? `'${t[2]}'` : (t[3] ?? '')
      for (const s of expr.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
        out.add((s[1] ?? s[2] ?? s[3] ?? '').replace(/\$\{[^}]*\}/g, ''))
      }
    }
  }
  return out
}

export function charset() {
  const brand =
    readFileSync('src/brand.ts', 'utf8')
      .match(/'([^']*)'/g)
      ?.join('') ?? ''
  const base =
    '0123456789 ·.,:：，。、-—/%¥（）()！？「」【】+~' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  return new Set([...brand, ...[...titleStrings()].join(''), ...base].filter((c) => c !== "'"))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cs = [...charset()].sort().join('')
  mkdirSync(dirname(WOFF2), { recursive: true })
  if (!existsSync(SRC)) {
    console.error(
      `找不到字体源文件 ${SRC}\n` +
        `请下载：curl -L -o "${SRC}" https://github.com/lxgw/LxgwWenKai/releases/download/v1.520/LXGWWenKai-Light.ttf`,
    )
    process.exit(1)
  }
  execFileSync('pyftsubset', [
    SRC,
    `--text=${cs}`,
    '--flavor=woff2',
    '--layout-features=',
    '--no-hinting',
    '--desubroutinize',
    `--output-file=${WOFF2}`,
  ])
  writeFileSync(CHARSET, cs)
  const b64 = readFileSync(WOFF2).toString('base64')
  writeFileSync(
    SCSS,
    `// 由 scripts/build-font-subset.mjs 生成，请勿手改。\n` +
      `// 霞鹜文楷 Light（LXGW WenKai，SIL OFL 1.1）子集，${cs.length} 字。\n` +
      `@font-face {\n  font-family: 'Example Display';\n  font-weight: 400;\n  font-style: normal;\n` +
      `  src: url('data:font/woff2;base64,${b64}') format('woff2');\n}\n`,
  )
  console.log(
    `${cs.length} 字 -> ${(readFileSync(WOFF2).length / 1024).toFixed(1)} KB woff2, ` +
      `${(b64.length / 1024).toFixed(1)} KB base64`,
  )
}
