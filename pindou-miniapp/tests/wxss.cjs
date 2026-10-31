const fs = require('node:fs')
const path = require('node:path')

async function main() {
  const compilerPath = process.env.WECHAT_WXSS_COMPILER
  if (!compilerPath) throw new Error('Set WECHAT_WXSS_COMPILER to the developer tools node_modules/wcc/lib/wcsc.js')
  const compile = require(path.resolve(compilerPath))
  const cwd = path.resolve(__dirname, '../dist')
  const files = fs
    .readdirSync(cwd, { recursive: true })
    .filter((file) => file.endsWith('.wxss'))
    .map((file) => `./${file}`)
  if (!files.length) throw new Error('Build the miniapp before checking WXSS')
  await compile({
    cwd,
    files,
    contents: files.map((file) => fs.readFileSync(path.join(cwd, file), 'utf8')),
    pageCount: files.length,
    lazyload: true,
  })
  console.log(`PASS: WeChat WXSS compiler, ${files.length} files`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
