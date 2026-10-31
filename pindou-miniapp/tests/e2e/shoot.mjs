// 逐页采图：把每个注册路由都打开一遍，拍首屏，记下运行期异常。
//
// ★ 判图归人。脚本只负责「打开、等、拍、把异常记下来」，不替人判断「看起来对不对」——
//   `page.data()` 在编译产物里读到的常是缓存引用，靠它做断言只会得出假结论。
//
// 用法：npm run e2e:shoot            # 全部
//       npm run e2e:shoot -- patterns # 只拍名字里带 patterns 的
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { SHOTS, connect, open, shoot, sleep } from './lib.mjs'

// 顺序就是验收动线：先主包，再顾客分包，最后员工端。
const PLAN = [
  ['01-home', 'pages/index/index', true],
  ['02-patterns', 'pages/patterns/index', true],
  ['03-reservations', 'pages/customer/reservations/index'],
  ['04-experience', 'pages/customer/experience/index'],
  ['05-membership', 'pages/customer/membership/index'],
  ['06-my-reservations', 'pages/customer/my-reservations/index'],
  ['07-profile-edit', 'pages/customer/profile-edit/index'],
  ['08-orders', 'pages/orders/index', true],
  ['09-profile', 'pages/profile/index', true],
  ['10-staff-workbench', 'pages/staff/workbench/index'],
  ['11-staff-tables', 'pages/staff/tables/index'],
  ['12-staff-orders', 'pages/staff/orders/index'],
]

const only = process.argv.slice(2)
const plan = only.length ? PLAN.filter(([id]) => only.some((pick) => id.includes(pick))) : PLAN

const { mp, drain } = await connect()
const rows = []
for (const [id, route, tab] of plan) {
  drain()
  let note = 'ok'
  try {
    await open(mp, route, tab)
  } catch (error) {
    note = `打不开：${String(error?.message || error).slice(0, 120)}`
  }
  const current = await mp
    .currentPage()
    .then((page) => page?.path)
    .catch(() => '?')
  try {
    await shoot(mp, id)
    // 长页面首屏看不全（作品墙 12 张、预约页的平面图在选日期之下），再拍一张下滚的。
    await mp.pageScrollTo(900).catch(() => {})
    await sleep(1200)
    await shoot(mp, `${id}-scroll`)
  } catch (error) {
    note += ` / 截图失败：${String(error?.message || error).slice(0, 80)}`
  }
  const errs = drain()
  const ok = note === 'ok' && current === route
  rows.push({ id, route, current, note, errs })
  console.log(
    `${ok ? '✔' : '✖'} ${id.padEnd(20)} 落在 ${current}  ${note}` +
      (errs.length ? `  异常${errs.length}: ${errs.join(' | ').slice(0, 200)}` : ''),
  )
}
fs.writeFileSync(path.join(SHOTS, 'report.json'), `${JSON.stringify(rows, null, 2)}\n`)
console.log(`\n截图在 ${SHOTS}`)
await mp.disconnect()
