import assert from 'node:assert/strict'
import { environmentManager } from '@tanstack/react-query'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { useMemberCode } from '../src/hooks/member-code'
import { isMemberCode, memberCodeIntro, memberCodeRefreshMs, scanMemberCode } from '../src/services/member-code'
import { createQueryClient } from '../src/services/query'
import { StaffError } from '../src/services/staff'
import { events, page, session } from './helpers/live'
import { cleanup, renderHook } from './helpers/render'

vi.mock('@tarojs/taro', async () => (await import('./helpers/live')).taroModule)
vi.mock('../src/services/platform', async () => (await import('./helpers/live')).platformModule)
vi.mock('../src/services/events', async () => (await import('./helpers/live')).eventsModule)

// 会员码（2026-10-06）：顾客页显示期间每分钟换一个码、离开就停、换了人旧码立刻不显示；
// 员工「扫会员码」只认会员码的样子，过期、伪造的码按后端的说明提示。

environmentManager.setIsServer(() => false)
beforeEach(() => {
  session.reset(['customer'])
  events.reset()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

const code = (n: number) => `9${String(n).padStart(19, '0')}`

test('会员码的样子：首位 9 的 20 位数字，其余一律不是', () => {
  assert.equal(isMemberCode(code(1)), true)
  assert.equal(isMemberCode(` ${code(2)}\n`), true, '扫码枪、相机带回的首尾空白去掉')
  for (const bad of ['6901234567892', '13800138000', `8${code(1).slice(1)}`, `${code(1)}0`, '', 'examplebrand-table:x'])
    assert.equal(isMemberCode(bad), false, bad)
})

test('顾客页显示期间每分钟换一个码，离开页面就停，回来立即换新的', async () => {
  let issued = 0
  const issue = async () => ({ code: code(++issued), expiresAt: '', validSeconds: 90 })
  const view = renderHook(() => useMemberCode(issue), createQueryClient(), undefined)
  const state = () => view.result.current
  assert.equal(state().loading, true)
  await tick()
  assert.deepEqual([issued, state().code, state().expired, state().loading], [1, code(1), false, false])

  await tick(memberCodeRefreshMs - 1)
  assert.equal(issued, 1)
  await tick(1)
  assert.deepEqual([issued, state().code], [2, code(2)], '每分钟换一个')

  page.hide()
  await tick(10 * memberCodeRefreshMs)
  assert.equal(issued, 2, '离开页面、退到后台不再签发')
  page.show()
  assert.deepEqual([state().code, state().expired], [code(2), true], '离开太久，回来时旧码按 90 秒算已经过期')
  await tick()
  assert.deepEqual([issued, state().code, state().expired], [3, code(3), false], '回来立即换新的')

  // 手动刷新：马上换
  state().refresh()
  await tick()
  assert.deepEqual([issued, state().code], [4, code(4)])
})

test('签发失败：留着上一个码并说明，15 秒后再试；码过了 90 秒盖上「已过期」', async () => {
  let fail = false
  let issued = 0
  const issue = async () => {
    if (fail) throw new StaffError('network', '网络连接失败，请稍后重试')
    return { code: code(++issued), expiresAt: '', validSeconds: 90 }
  }
  const view = renderHook(() => useMemberCode(issue), createQueryClient(), undefined)
  const state = () => view.result.current
  await tick()
  assert.equal(state().code, code(1))

  fail = true
  await tick(memberCodeRefreshMs)
  assert.deepEqual([state().code, state().expired], [code(1), false], '换码失败时旧码还在有效期内，照常显示')
  assert.match(state().error, /网络连接失败/)
  await tick(30_000 - 1)
  assert.equal(state().expired, false)
  await tick(1)
  assert.equal(state().expired, true, '收到后满 90 秒就盖上「已过期」，不看后端给的 expiresAt')

  fail = false
  await tick(15_000)
  assert.deepEqual([state().code, state().expired, state().error], [code(2), false, ''], '重试成功换上新码')
})

test('换了登录身份，旧码立刻不显示；没登录不签发', async () => {
  let issued = 0
  const issue = async () => ({ code: code(++issued), expiresAt: '', validSeconds: 90 })
  const view = renderHook(() => useMemberCode(issue), createQueryClient(), undefined)
  await tick()
  assert.equal(view.result.current.code, code(1))

  session.signIn(['customer'], 'someone-else')
  assert.equal(view.result.current.code, null, '换了人旧码立刻不显示')
  await tick()
  assert.equal(view.result.current.code, code(2), '按新身份签发')

  session.signOut()
  await tick(5 * memberCodeRefreshMs)
  assert.deepEqual([issued, view.result.current.code], [2, null], '没登录不签发、不显示')
})

test('员工扫会员码：找到顾客、取消、扫不出、不是会员码、过期（后端的说明原样给）', async () => {
  const lookups: string[] = []
  const alice = { id: 'alice', nickname: 'Alice', phoneMasked: '138****8000' }
  const lookup = async (value: string) => {
    lookups.push(value)
    if (value === code(9)) throw new StaffError('member_code_expired', '会员码已过期，请顾客刷新会员码后再扫', 410)
    return alice as any
  }
  const scan = (result: string) => async () => ({ result })

  assert.deepEqual(await scanMemberCode(scan(` ${code(1)}\n`), lookup), { kind: 'found', account: alice })
  assert.deepEqual(lookups, [code(1)], '按去掉空白的码查')

  const cancelled = async () => Promise.reject({ errMsg: 'scanCode:fail cancel' })
  assert.deepEqual(await scanMemberCode(cancelled, lookup), { kind: 'cancelled' })
  const failed = await scanMemberCode(async () => Promise.reject({ errMsg: 'scanCode:fail' }), lookup)
  assert.equal(failed.kind, 'error')

  for (const notMember of ['6901234567892', 'examplebrand-table:abc', 'pindou-web-login:x']) {
    const outcome = await scanMemberCode(scan(notMember), lookup)
    assert.equal(outcome.kind, 'error', notMember)
    assert.match((outcome as { message: string }).message, /不是会员码/)
  }
  assert.equal(lookups.length, 1, '不像会员码的不去问后端')

  assert.deepEqual(await scanMemberCode(scan(code(9)), lookup), {
    kind: 'error',
    message: '会员码已过期，请顾客刷新会员码后再扫',
  })
})

test('会员码说明：收费关着时不提结账', () => {
  assert.match(memberCodeIntro(true), /结账/)
  assert.doesNotMatch(memberCodeIntro(false), /结账/)
  assert.match(memberCodeIntro(false), /充值、兑换积分或领生日礼物/)
})
