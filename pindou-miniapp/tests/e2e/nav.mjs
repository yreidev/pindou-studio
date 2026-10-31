// 真点击跳转验证。
//
// ★★ 这才是路由改动的验收点。`reLaunch` 是从外面直接拉起页面，**绕开了页面里的 navigateTo**；
//   而 2026-09-19 做分包时改动最大的就是那 46 处路由字面量
//   （/pages/membership/index → /pages/customer/membership/index）。
//   单测验的是 fallbackPage 的兜底表和白名单，验不了「按钮上写的 url 和 app.config 里
//   注册的路径对不对得上」。只有真的去点，才知道。
//
// ★ 选择器按 section 限定，别拿下标猜：首页「全部 ›」有好几个（今天还能约、本周上新），
//   第一版拿 [0] 猜，点到的是别的按钮，报了个假缺陷。
//   首页「本次手作」直接调扫码，进不了页面，不在这里点。
//
// 用法：npm run e2e:nav
import { connect, open, shoot, sleep } from './lib.mjs'

// [从哪页出发, tab?, 选择器, 第几个, 叫什么（日志好读）, 期望落到哪]
const CASES = [
  ['pages/index/index', true, '.home-action', 0, '首页-预约座位', 'pages/customer/reservations/index'],
  ['pages/index/index', true, '.home-action', 2, '首页-示例工坊社', 'pages/customer/membership/index'],
  ['pages/index/index', true, '.home-slot', 0, '首页-今天还能约', 'pages/customer/reservations/index'],
  ['pages/index/index', true, '.home-featured .home-block-more', 0, '首页-全部图纸', 'pages/patterns/index'],
  ['pages/patterns/index', true, '.patterns-card', 0, '图纸-第一张', 'pages/customer/pattern/index'],
  ['pages/profile/index', true, '.profile-service', 0, '我的-会员中心', 'pages/customer/membership/index'],
  ['pages/profile/index', true, '.profile-link', 0, '我的-本次手作', 'pages/customer/experience/index'],
  ['pages/profile/index', true, '.profile-link', 1, '我的-预约座位', 'pages/customer/reservations/index'],
  ['pages/profile/index', true, '.profile-link', 2, '我的-我的预约', 'pages/customer/my-reservations/index'],
  ['pages/profile/index', true, '.profile-avatar-button', 0, '我的-编辑头像', 'pages/customer/profile-edit/index'],
  ['pages/profile/index', true, '.profile-workbench', 0, '我的-员工工作台', 'pages/staff/workbench/index'],
  [
    'pages/customer/my-reservations/index',
    false,
    '.my-reservations-book',
    0,
    '我的预约-去预约座位',
    'pages/customer/reservations/index',
  ],
  ['pages/customer/membership/index', false, '.button-primary', 0, '会员-本次手作', 'pages/customer/experience/index'],
]

const { mp, drain } = await connect()
let pass = 0
for (const [from, tab, selector, nth, name, want] of CASES) {
  try {
    await open(mp, from, tab)
  } catch (error) {
    console.log(`✖ ${name.padEnd(18)} 起点 ${from} 打不开：${error.message}`)
    continue
  }
  drain()
  const page = await mp.currentPage()
  const els = await page.$$(selector).catch(() => [])
  if (!els[nth]) {
    console.log(`✖ ${name.padEnd(18)} 在 ${from} 上找不到 ${selector}[${nth}]（共 ${els.length} 个）`)
    continue
  }
  await els[nth].tap()
  await sleep(2500)
  const now = await mp
    .currentPage()
    .then((p) => p?.path)
    .catch(() => '?')
  const errs = drain()
  const ok = now === want
  if (ok) pass++
  else await shoot(mp, `nav-fail-${name}`)
  console.log(
    `${ok ? '✔' : '✖'} ${name.padEnd(18)} ${from} → ${now}` +
      (ok ? '' : `  期望 ${want}`) +
      (errs.length ? `  异常${errs.length}: ${errs.join('|').slice(0, 150)}` : ''),
  )
}
console.log(`\n${pass}/${CASES.length} 条跳转正确`)
await mp.disconnect()
if (pass !== CASES.length) process.exitCode = 1
