// 用微信官方 miniprogram-ci 预览或上传小程序，不开开发者工具。
//
//   WECHAT_MP_UPLOAD_KEY=<代码上传密钥文件路径> node mp.mjs preview
//   WECHAT_MP_UPLOAD_KEY=<代码上传密钥文件路径> node mp.mjs upload [说明]
//
// 上传的是 pindou-miniapp/dist（先在 pindou-miniapp 里 npm run build:weapp），版本号取 pindou-miniapp/package.json，
// 产物里内置的版本号对不上就拒绝（小程序页脚显示的版本和体验版面板上的版本必须一致）。
// 编译设置照搬 dist/project.config.json：和以前用开发者工具上传的包一样。
//
// ★ 以前用开发者工具的命令行上传，会按分包缓存旧的编译结果、跑久了剔掉主包图片、cli quit 还会关掉人正开着的窗口。
//   miniprogram-ci 每次从产物目录重新打包，没有这些问题。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ci = require('miniprogram-ci')
const here = path.dirname(new URL(import.meta.url).pathname)
const miniapp = path.resolve(here, '../../pindou-miniapp')
const dist = path.join(miniapp, 'dist')

const [action, ...rest] = process.argv.slice(2)
if (action !== 'preview' && action !== 'upload') {
  console.error('用法：node mp.mjs preview | upload [说明]')
  process.exit(2)
}
const keyPath = process.env.WECHAT_MP_UPLOAD_KEY
if (!keyPath || !fs.existsSync(keyPath)) {
  console.error('缺代码上传密钥：把 WECHAT_MP_UPLOAD_KEY 设为密钥文件的路径（公众平台 → 开发管理 → 开发设置 → 小程序代码上传）')
  process.exit(2)
}
if (!fs.existsSync(path.join(dist, 'app.json'))) {
  console.error('pindou-miniapp/dist 里没有构建产物，先在 pindou-miniapp 里 npm run build:weapp')
  process.exit(2)
}

const config = JSON.parse(fs.readFileSync(path.join(dist, 'project.config.json'), 'utf8'))
if (!/^wx[0-9a-f]{16}$/i.test(config.appid)) {
  console.error('上传前必须通过 TARO_APP_ID 注入正式 AppID 并重新构建')
  process.exit(2)
}
const version = JSON.parse(fs.readFileSync(path.join(miniapp, 'package.json'), 'utf8')).version
const common = fs.readFileSync(path.join(dist, 'common.js'), 'utf8')
if (!common.includes(`"${version}"`) && !common.includes(`'${version}'`)) {
  console.error(`产物里内置的版本号不是 ${version}：改了 package.json 却没重新 build？先 npm run build:weapp`)
  process.exit(2)
}

const project = new ci.Project({
  appid: config.appid,
  type: 'miniProgram',
  projectPath: dist,
  privateKeyPath: keyPath,
  ignores: ['node_modules/**/*'],
})
// 和 dist/project.config.json 里开发者工具的设置一致
const s = config.setting || {}
const setting = {
  es6: Boolean(s.es6),
  es7: Boolean(s.enhance),
  minify: Boolean(s.minified),
  minifyJS: Boolean(s.minified),
  minifyWXML: Boolean(s.minifyWXML),
  minifyWXSS: Boolean(s.minifyWXSS),
  autoPrefixWXSS: Boolean(s.postcss),
  disableUseStrict: Boolean(s.disableUseStrict),
}
const desc = rest.join(' ') || `${version}`
let lastProgress = ''
const onProgressUpdate = (task) => {
  const message = typeof task === 'string' ? task : `${task._msg || ''} ${task._status || ''}`.trim()
  if (message && message !== lastProgress && !/^\s*$/.test(message)) {
    lastProgress = message
    if (process.env.MP_CI_VERBOSE) console.log('  ', message)
  }
}

function printSizes(result) {
  const packages = result?.subPackageInfo || []
  for (const p of packages) console.log(`${p.name.padEnd(20)} ${String(p.size).padStart(10)} B`)
}

// 微信回的错误只取关键的一句；errCode -10008 是 IP 白名单拦的
function fail(error) {
  const text = String(error?.message || error)
  const wechat = text.match(/\{"errCode":-?\d+[^}]*\}/)
  console.error(wechat ? `微信拒绝了这次${action === 'upload' ? '上传' : '预览'}：${wechat[0]}` : text.split('\n')[0].slice(0, 500))
  if (/-10008|invalid ip/.test(text)) console.error('公众平台「开发管理 → 开发设置 → 小程序代码上传 → IP白名单」还开着：关掉它，或加上上面那个地址')
  process.exit(1)
}

try {
if (action === 'preview') {
  const qrcodeOutputDest = path.join(here, 'preview-qrcode.jpg')
  const result = await ci.preview({
    project,
    desc,
    setting,
    qrcodeFormat: 'image',
    qrcodeOutputDest,
    robot: 1,
    onProgressUpdate,
  })
  printSizes(result)
  console.log(`预览码：${qrcodeOutputDest}（用开发者微信扫，25 分钟有效）`)
} else {
  const result = await ci.upload({ project, version, desc, setting, robot: 1, onProgressUpdate })
  printSizes(result)
  console.log(`已上传 ${version}：${desc}。体验版会自动变成最新上传的这一版（体验版设的是 robot 1 时，到公众平台「版本管理」核对）`)
}
} catch (error) {
  fail(error)
}
