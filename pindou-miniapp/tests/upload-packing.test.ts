import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'vitest'
import { root } from './helpers/load'

// 上传时不许让微信按「静态引用」裁掉资源文件。
//
// ★★ 2026-09-19 真机发布踩到的坑。微信开发者工具的 `setting.ignoreUploadUnusedFiles`
//    **默认是 true**：上传时它会静态分析代码，把「没被引用到」的文件从包里剔掉。
//    当时作品图的路径是运行时拼的（模板字符串 `/pages/customer/assets/gallery/${id}.jpg`），
//    它分析不出来，于是**12 张作品图和座位平面图全被剔掉**，上传照样成功、不报任何错。
//    作品图 2026-10-20 换成员工上传、从接口读的图纸，不在包里了；座位平面图仍是这种情况。
//
//    实测体积（同一份 dist）：
//      ignoreUploadUnusedFiles 默认 true  →  /pages/customer/  64,205 B
//      显式置 false 并重开项目            →  /pages/customer/ 452,371 B
//    2.1.0 和 2.1.1 两个版本就是这么传出去的，顾客看到的作品墙会是一片空白。
//
// ★ 这条门禁只盯配置，不盯上传：上传要联网、要开发者工具，进不了 `npm test`。
//   但「配置被人改回去」是这个坑唯一的复发路径，钉住它就够了。
//
// ★★ 另一件必须记住的事：**改完这个配置要重开项目才生效**。CLI 的 upload/preview
//    都是走正在运行的 IDE，而 IDE 只在打开项目时读一次 project.config.json。
//    我第一次改完直接重传，体积一个字节都没变，差点据此误判这个设置无效。
test('the upload must not let WeChat strip assets it cannot statically see', () => {
  const file = path.resolve(root, 'project.config.json')
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))

  assert.equal(
    config.setting.ignoreUploadUnusedFiles,
    false,
    'project.config.json 的 setting.ignoreUploadUnusedFiles 必须显式为 false。\n' +
      '  它默认 true，会把运行时拼路径引用的图片整批剔出上传包 —— 上传不报错，\n' +
      '  模拟器里（读本地 dist）也看不出来，只有真机上是空白图。',
  )

  // packOptions.include 是**白名单**不是「追加」：一旦非空，没列进去的文件全被排除，
  // 上传会直接报 800059 file not found: pages/index/index.js。别拿它来补资源。
  assert.deepEqual(
    config.packOptions.include,
    [],
    'packOptions.include 是白名单，填了它其余文件会被整体排除，上传必失败。',
  )
})

// 运行时拼路径的资源，必须真的存在于构建产物里。
//
// 静态分析看不见它们，所以没有任何编译期检查会发现路径写错；写错了就是真机白图。
test('every runtime-built asset path resolves to a real file in dist', (context) => {
  const dist = path.resolve(root, 'dist')
  if (!fs.existsSync(path.join(dist, 'app.json'))) {
    context.skip('dist 还没构建，跳过（npm run build:weapp 之后再跑）')
    return
  }
  const missing: string[] = []
  // 平面图在页面里是字面量，但走 copy.patterns 拷进去，拷错目录就是白图。
  // ★ 座位底图在**主包**：顾客端与员工端共用同一张，而分包之间不能互相引用资源
  //   （见 tests/subpackage-assets.test.ts）。
  const plan = '/assets/seatmap/plan.jpg'
  if (!fs.existsSync(path.join(dist, plan))) missing.push(plan)

  assert.deepEqual(missing, [], `这些资源在 dist 里不存在，真机上会是白图：\n  ${missing.join('\n  ')}`)
})
