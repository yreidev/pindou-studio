// 端到端采集的公共设施：起自动化端口、连上开发者工具、收集运行期异常。
//
// ★★ 这一层存在的理由：`npm test` 那 137 条跑在 node + 手搓的 hooks 沙箱里，既没有小程序的
//   自定义组件边界，也不会真的注册路由。它能证明 `fallbackPage` 的兜底表对，却证明不了
//   **按钮上写的那个 url 和 app.config 里注册的路径对得上** —— 2026-09-19 做分包时改了
//   46 处路由字面量，单测全绿也说明不了它们没改漏。automator 连的是开发者工具里**真正的
//   小程序运行时**，点下去落到哪一页是它说了算。
//
// ── 环境 ──────────────────────────────────────────────────────────────────────
//   开发者工具没有官方 Linux 版，用社区 msojocs 移植版，**必须 2.02 及以上**
//   （2.01 的 `Page.*` 不回包），且用 tar.gz 不要 AppImage。完整安装与排错见
//   全局 skill `mp-weixin-e2e`。
//
// ★ `--auto-port` 是**隐藏参数**：`cli auto --help` 里没有，但 CLI 真的认。
//   不传它只会打印 `✔ auto` 然后什么端口都不开，白等。
// ★ 端口**不是立刻就绪**：`✔ auto` 之后还要约 10 秒 9420 才 listen，所以要轮询。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import automator from 'miniprogram-automator'

export const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const DIST = path.join(PROJECT, 'dist')
export const SHOTS = process.env.E2E_SHOTS || path.join(PROJECT, '.e2e-shots')
const PORT = Number(process.env.AUTO_PORT || 9420)

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const listening = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })

/** 找开发者工具的 cli。装在哪儿因机而异，所以既扫常见目录也认环境变量。 */
function findCli() {
  if (process.env.WECHAT_DEVTOOLS_CLI) return process.env.WECHAT_DEVTOOLS_CLI
  for (const root of [`${process.env.HOME}/Applications`, '/opt']) {
    if (!fs.existsSync(root)) continue
    for (const dir of fs.readdirSync(root)) {
      const hit = path.join(root, dir)
      if (!fs.statSync(hit).isDirectory()) continue
      const direct = path.join(hit, 'bin/wechat-devtools-cli')
      if (fs.existsSync(direct)) return direct
      for (const sub of fs.readdirSync(hit)) {
        const nested = path.join(hit, sub, 'bin/wechat-devtools-cli')
        if (fs.existsSync(nested)) return nested
      }
    }
  }
  return null
}

export async function ensureAutomation() {
  if (await listening(PORT)) return
  if (!fs.existsSync(path.join(DIST, 'app.json'))) throw new Error(`${DIST} 里没有 app.json —— 先 npm run build:weapp`)
  const cli = findCli()
  if (!cli) {
    throw new Error(
      `自动化端口 ${PORT} 没开，也没找到开发者工具的 cli。\n` +
        '  先手动打开微信开发者工具，或设 WECHAT_DEVTOOLS_CLI 指向它的 cli。',
    )
  }
  execFileSync(cli, ['auto', '--project', PROJECT, '--auto-port', String(PORT), '--trust-project'], {
    stdio: 'inherit',
    timeout: 300_000,
  })
  for (let i = 0; i < 60; i++) {
    if (await listening(PORT)) return
    await sleep(1000)
  }
  throw new Error(`cli auto 跑完了，但 ${PORT} 迟迟没 listen`)
}

/**
 * 连上小程序，并把运行期异常收集起来。
 * 返回 `{ mp, errors, drain() }` —— `drain()` 取走并清空，便于按页归属。
 */
// ★★ 采图前必须确认模拟器跑的是**新产物**，否则采到的图是假证据 —— 比不采更糟。
//
//   2026-09-19 在这上面连栽三次：改完代码重新 `npm run build:weapp`，然后
//   `cli close` + `cli open`、`cli cache --clean compile` 都试过，模拟器照样跑旧编译
//   （元素探针给的铁证：页面上还是改名前的类名）。据此采到的图让我以为样式没修好，
//   来回折腾了好几轮。
//
//   **唯一可靠的办法是 `cli quit` 退出整个 IDE，再让 `cli auto` 重新拉起** ——
//   它会完整编译一遍。storage 不受影响，登录态保得住
//   （`cache --clean all` 才会连 storage 一起清，别用那条）。
//
//   判断有没有采到旧编译：挑一个只在新代码里出现的类名，用 `page.$$('.那个类')`
//   数一下，0 就是旧的。
export async function connect() {
  await ensureAutomation()
  const errors = []
  // ★★ 开发者工具会把自己那边的报错当普通消息推过来，automator 在 Connection.onMessage
  //   里解构它就抛了 —— 抛在**消息回调**里，不在我们 await 的那条链上，try/catch 接不住，
  //   整个 node 进程直接挂。实测最常见的一条是
  //     Cannot destructure property 'rawPath' of 't.getPageMetaByWebviewId(...)' as it is null
  //   意思只是小程序还没渲染出第一个页面。拦住它记下来，不让它掀桌。
  process.on('uncaughtException', (error) => {
    const message = String(error?.message || error)
    errors.push(`[IDE] ${message}`)
    console.error(`⚠ 忽略 IDE 侧异常：${message.slice(0, 140)}`)
  })
  const mp = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${PORT}` })
  mp.on('exception', (error) => errors.push(String(error?.message || error)))
  // ★ 等小程序真的渲染出第一个页面再交给调用方，否则第一条协议就问到 null。
  let ready = null
  for (let i = 0; i < 30; i++) {
    try {
      const page = await mp.currentPage()
      if (page?.path) {
        ready = page.path
        break
      }
    } catch {
      /* 还没就绪 */
    }
    await sleep(1000)
  }
  // ★★ 读不到当前页就**中止**，不要「继续往下走」。
  //   2026-09-19 实测：模拟器没起来时继续跑，前几页全部「打不开 + 截图超时」，
  //   中途模拟器好了又采出几张 —— 得到一套残缺且顺序错乱的图，日志还被管道缓冲住看不见。
  //   残缺的证据比没有证据更糟：它看起来像证据。
  if (!ready)
    throw new Error(
      '等了 30 秒模拟器仍没渲染出第一个页面（多半是 IDE 刚被重启、还在编译）。中止，请确认开发者工具已正常打开项目后重跑。',
    )
  console.error(`小程序已就绪，当前页 ${ready}`)
  fs.mkdirSync(SHOTS, { recursive: true })
  return { mp, errors, drain: () => errors.splice(0, errors.length) }
}

/**
 * 截图落盘。
 *
 * ★★ 必须自己拿 base64 写文件。传 `screenshot({ path })` 让 IDE 那边写盘，实测文件会**建出来
 *   但是 0 字节**，而且不报错 —— 一整轮 12 张全是空的才发现。
 */
export async function shoot(mp, name) {
  const base64 = await mp.screenshot()
  if (typeof base64 !== 'string' || base64.length < 100)
    throw new Error(`截图数据异常：${typeof base64} ${base64?.length}`)
  const file = path.join(SHOTS, `${name.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.png`)
  fs.writeFileSync(file, Buffer.from(base64, 'base64'))
  return file
}

/** 从构建产物的 app.json 读全部路由（主包 + 分包），与真机注册的完全一致。 */
export function allRoutes() {
  const app = JSON.parse(fs.readFileSync(path.join(DIST, 'app.json'), 'utf8'))
  const tabs = new Set((app.tabBar?.list ?? []).map((tab) => tab.pagePath))
  const out = app.pages.map((page) => ({ path: page, tab: tabs.has(page), pkg: '主包' }))
  for (const sub of app.subPackages ?? []) {
    for (const page of sub.pages) out.push({ path: `${sub.root}/${page}`, tab: false, pkg: sub.root })
  }
  return out
}

/**
 * 打开一页。tab 页必须 switchTab，其余 reLaunch。
 *
 * ★ 要重试：开发者工具偶尔会吞掉一条协议，回一个
 *   `timeout waiting for automator response`。实测是**纯抖动** —— 同一个起点紧接着的
 *   下一条用例就正常了。不重试的话这种抖动会被记成跳转失败，等于让工具虚报缺陷，
 *   而虚报比漏报更糟：人会开始不信这份报告。
 */
export async function open(mp, route, tab, attempts = 3) {
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      if (tab) await mp.switchTab(`/${route}`)
      else await mp.reLaunch(`/${route}`)
      await sleep(2500)
      const now = await mp.currentPage().then((page) => page?.path)
      if (now === route) return
      last = new Error(`打开 ${route} 之后落在 ${now}`)
    } catch (error) {
      last = error
    }
    console.error(`  ↻ 打开 ${route} 第 ${i + 1} 次没成：${String(last?.message || last).slice(0, 80)}`)
    await sleep(1500)
  }
  throw last
}
