import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'vitest'
import type { ServiceCall } from '../src/services/service-calls'
import { load, src } from './helpers/load'

// 呼叫店员：顾客在「本次手作」页叫，员工在工作台看到并点「已处理」。状态都由后端算（displayStatus、
// cooldownSeconds），小程序只在两次刷新之间倒数；顾客侧报错只用白名单文案。

const call = (patch: Partial<ServiceCall> = {}): ServiceCall => ({
  id: 'c1',
  venueSessionId: 's1',
  serviceTableId: 't1',
  tableCode: 'B3',
  seatNumber: 2,
  status: 'pending',
  displayStatus: 'pending',
  createdAt: '2026-10-05T06:00:00Z',
  handledAt: null,
  cooldownSeconds: 0,
  claimStatus: 'none',
  claimedAt: null,
  ...patch,
})

const zhou = { id: 'u-zhou', nickname: '小周', phoneMasked: '139****0001' }
/** 小周在 claimedAt 点了「我去处理」，此刻认领着（claimed）或已满 10 分钟（lapsed）。 */
const claimedCall = (
  claimStatus: 'claimed' | 'lapsed',
  claimedAt = '2026-10-05T06:01:00Z',
  patch: Partial<ServiceCall> = {},
) => call({ claimStatus, claimedAt, claimedBy: zhou, ...patch })

async function setup(reply: (args: any) => { statusCode: number; data: unknown }) {
  const calls: any[] = []
  const taro = {
    getStorageSync: () => ({ accessToken: 'test-token' }),
    request: async (args: any) => {
      calls.push(args)
      return reply(args)
    },
  }
  const service = await load<typeof import('../src/services/service-calls')>('services/service-calls.ts', {
    '@tarojs/taro': { default: taro },
  })
  return { service, calls }
}

test('顾客呼叫、读自己的呼叫，员工读未处理的、标记已处理：路径与方法对，不带幂等键', async () => {
  const { service, calls } = await setup(() => ({ statusCode: 200, data: [] }))
  await service.serviceCalls.mine()
  await service.serviceCalls.call('s1')
  await service.serviceCalls.open()
  await service.serviceCalls.handle('c1')
  await service.serviceCalls.claim('c1')
  assert.deepEqual(
    calls.map((c) => [c.method, c.url.replace(/^.*\/api\/v2/, '')]),
    [
      ['GET', '/service-calls/me'],
      ['POST', '/service-calls'],
      ['GET', '/service-calls?scope=open'],
      ['POST', '/service-calls/c1/handle'],
      ['POST', '/service-calls/c1/claim'],
    ],
  )
  assert.deepEqual(calls[1].data, { venueSessionId: 's1' })
  assert.ok(
    calls.every((c) => !('Idempotency-Key' in c.header)),
    '重复叫、重复点都无害，不带幂等键',
  )
})

test('顾客侧报错只用白名单文案，不把服务端原文给顾客看', async () => {
  let reply = {
    statusCode: 409,
    data: { code: 'no_active_session', message: 'session 3f2… not live (venue_sessions)' },
  }
  const { service } = await setup(() => reply)
  await assert.rejects(
    service.serviceCalls.call('s1'),
    (e: any) => e.name === 'CustomerError' && e.status === 409 && e.message === '你现在没有进行中的计时，不能呼叫店员',
  )
  reply = { statusCode: 429, data: { code: 'service_call_cooldown', message: '店员刚处理过你的呼叫，40 秒后可以再叫' } }
  await assert.rejects(service.serviceCalls.call('s1'), (e: any) => e.message === '店员刚处理过你的呼叫，请稍后再叫')
  reply = {
    statusCode: 500,
    data: { code: 'persistence_rejected', message: 'violates check constraint service_calls_handled' },
  }
  await assert.rejects(
    service.serviceCalls.mine(),
    (e: any) => e.message === '服务暂时不可用，请稍后重试' && e.status === 500,
  )
  // 员工侧照旧显示服务端的中文说明
  reply = { statusCode: 404, data: { code: 'not_found', message: '呼叫不存在' } }
  await assert.rejects(service.serviceCalls.handle('c1'), (e: any) => e.name === 'StaffError' && e.status === 404)
  // 别人先认领了：照原样告诉店员是谁在处理
  reply = { statusCode: 409, data: { code: 'service_call_claimed', message: '小周 已在处理' } }
  await assert.rejects(
    service.serviceCalls.claim('c1'),
    (e: any) => e.name === 'StaffError' && e.code === 'service_call_claimed' && e.message === '小周 已在处理',
  )
})

test('顾客页的呼叫状态：等店员、已处理后倒数 1 分钟、过期可再叫', async () => {
  const { service } = await setup(() => ({ statusCode: 200, data: [] }))
  const { callState } = service
  const fetched = Date.parse('2026-10-05T06:05:00Z')
  assert.deepEqual(callState(undefined, fetched, fetched), { kind: 'idle', handled: false })
  assert.deepEqual(callState(call(), fetched, fetched), {
    kind: 'waiting',
    since: '2026-10-05T06:00:00Z',
    coming: false,
  })
  // 有店员点了「我去处理」：写「店员正在过来」，不说是哪位；认领失效后回到「马上就到」
  assert.deepEqual(callState(call({ claimStatus: 'claimed' }), fetched, fetched), {
    kind: 'waiting',
    since: '2026-10-05T06:00:00Z',
    coming: true,
  })
  assert.deepEqual(callState(call({ claimStatus: 'lapsed' }), fetched, fetched), {
    kind: 'waiting',
    since: '2026-10-05T06:00:00Z',
    coming: false,
  })
  assert.deepEqual(callState(call({ displayStatus: 'expired' }), fetched, fetched), { kind: 'expired' })
  const handled = call({
    status: 'handled',
    displayStatus: 'handled',
    handledAt: '2026-10-05T06:04:40Z',
    cooldownSeconds: 40,
  })
  assert.deepEqual(callState(handled, fetched, fetched), { kind: 'cooldown', seconds: 40 })
  // 两次刷新之间按读到时的剩余秒数倒数，不看手机时钟
  assert.deepEqual(callState(handled, fetched, fetched + 15_500), { kind: 'cooldown', seconds: 25 })
  assert.deepEqual(callState(handled, fetched, fetched + 40_000), { kind: 'idle', handled: true })
  assert.deepEqual(
    callState(call({ status: 'handled', displayStatus: 'handled', cooldownSeconds: 0 }), fetched, fetched),
    {
      kind: 'idle',
      handled: true,
    },
  )
})

test('员工工作台：「B3 桌 呼叫 · N 分钟前」，打开时已挂着的不振，之后新到的才振', async () => {
  const { service } = await setup(() => ({ statusCode: 200, data: [] }))
  const at = Date.parse('2026-10-05T06:00:00Z')
  assert.equal(service.callTable(call()), 'B3 桌')
  assert.equal(service.waited('2026-10-05T06:00:00Z', at + 30_000), '刚刚')
  assert.equal(service.waited('2026-10-05T06:00:00Z', at + 3 * 60_000), '3 分钟前')
  assert.equal(service.waited('2026-10-05T06:00:00Z', at - 5_000), '刚刚')
  assert.deepEqual(service.arrivals(null, [call()]), [])
  assert.deepEqual(
    service.arrivals(new Set(['c1']), [call(), call({ id: 'c2' })]).map((c) => c.id),
    ['c2'],
  )
  assert.deepEqual(service.arrivals(new Set(['c1', 'c2']), [call({ id: 'c2' })]), [])
})

test('新呼叫没人处理就每 4 秒振一次：处理了、振满 5 分钟就停，再来新的从它重新计时', async () => {
  const { service } = await setup(() => ({ statusCode: 200, data: [] }))
  const at = Date.parse('2026-10-05T06:00:00Z')
  const ids = (buzz: { ids: ReadonlySet<string> } | null) => (buzz ? [...buzz.ids].sort() : null)
  // 打开时已挂着的（没有新到的）不振
  assert.equal(service.buzzAfterRead(null, [], [call()], at), null)
  const first = service.buzzAfterRead(null, [call()], [call()], at)
  assert.deepEqual(ids(first), ['c1'])
  assert.equal(first?.since, at)
  // 重读还在、没新的：照旧，计时不变
  assert.equal(service.buzzAfterRead(first, [], [call()], at + 10_000)?.since, at)
  // 又来一条：两条都振，从新的这条起重新计时
  const second = service.buzzAfterRead(first, [call({ id: 'c2' })], [call(), call({ id: 'c2' })], at + 60_000)
  assert.deepEqual(ids(second), ['c1', 'c2'])
  assert.equal(second?.since, at + 60_000)
  // 处理了一条接着振另一条；引起振动的都不在未处理里了就停（别的老呼叫还挂着也不振）
  assert.deepEqual(ids(service.buzzAfterRead(second, [], [call({ id: 'c2' })], at + 70_000)), ['c2'])
  assert.equal(service.buzzAfterRead(second, [], [call({ id: 'old' })], at + 70_000), null)

  // 节奏：离上次够 4 秒才振，满 5 分钟停；锁屏回来按真实时间算，不补振
  assert.equal(service.buzzDue(null, 0, at), 'stop')
  assert.equal(service.buzzDue(first, at, at + 3_999), 'wait')
  assert.equal(service.buzzDue(first, at, at + 4_000), 'buzz')
  assert.equal(service.buzzDue(first, at + 2 * 60_000, at + 2 * 60_000 + 4_000), 'buzz')
  assert.equal(service.buzzDue(first, at, at + 5 * 60_000), 'stop')
})

test('有人点了「我去处理」就不再为它振动（自己点的也一样）；认领满 10 分钟没处理的重新振，算一次新到', async () => {
  const { service } = await setup(() => ({ statusCode: 200, data: [] }))
  const at = Date.parse('2026-10-05T06:00:00Z')
  const { alertKeys, arrivals, buzzAfterRead } = service
  const ids = (buzz: { ids: ReadonlySet<string> } | null) => (buzz ? [...buzz.ids].sort() : null)

  // 新呼叫振起来；小周点了「我去处理」，重读到 claimed：引起振动的都不用提醒了，停
  const first = buzzAfterRead(null, [call()], [call()], at)
  assert.deepEqual(ids(first), ['c1'])
  const afterClaim = [claimedCall('claimed')]
  assert.deepEqual(arrivals(alertKeys([call()]), afterClaim), [], '认领不是新到')
  assert.equal(buzzAfterRead(first, [], afterClaim, at + 10_000), null)
  // 两条在振，认领了其中一条：只接着振另一条
  const two = buzzAfterRead(null, [call(), call({ id: 'c2' })], [call(), call({ id: 'c2' })], at)
  assert.deepEqual(ids(buzzAfterRead(two, [], [claimedCall('claimed'), call({ id: 'c2' })], at + 10_000)), ['c2'])
  // 认领着的从提醒的键里拿掉；没人认领的键就是编号
  assert.deepEqual([...alertKeys([claimedCall('claimed'), call({ id: 'c2' })])], ['c2'])

  // 认领满 10 分钟还没处理（lapsed）：换一个键，算新到，重新振
  let seen = alertKeys(afterClaim)
  const lapsed = [claimedCall('lapsed')]
  const again = arrivals(seen, lapsed)
  assert.deepEqual(
    again.map((c) => c.id),
    ['c1'],
  )
  const rebuzz = buzzAfterRead(null, again, lapsed, at + 11 * 60_000)
  assert.deepEqual(ids(rebuzz), ['c1@2026-10-05T06:01:00Z'])
  assert.equal(rebuzz?.since, at + 11 * 60_000)
  // 下一次重读还是这次失效：不再算新到，照旧振
  seen = alertKeys(lapsed)
  assert.deepEqual(arrivals(seen, lapsed), [])
  assert.deepEqual(ids(buzzAfterRead(rebuzz, [], lapsed, at + 11 * 60_000 + 5_000)), ['c1@2026-10-05T06:01:00Z'])
  // 有人接手（重新认领）：停；再失效又是新的一次
  const retaken = [claimedCall('claimed', '2026-10-05T06:12:00Z')]
  assert.equal(buzzAfterRead(rebuzz, [], retaken, at + 12 * 60_000), null)
  seen = alertKeys(retaken)
  assert.deepEqual(
    arrivals(seen, [claimedCall('lapsed', '2026-10-05T06:12:00Z')]).map((c) => c.id),
    ['c1'],
  )

  // 打开工作台时已经认领失效的也不算新到（同新呼叫）
  assert.deepEqual(arrivals(null, lapsed), [])
  // 旧版后端不带 claimStatus：照旧按编号提醒
  const old = call({
    claimStatus: undefined as unknown as ServiceCall['claimStatus'],
    claimedAt: undefined as unknown as null,
  })
  assert.deepEqual([...alertKeys([old])], ['c1'])
})

test('工作台的认领说明：「小周 正在处理 · 2 分钟前」；认领满 10 分钟写还没处理；没人认领不写', async () => {
  const { service } = await setup(() => ({ statusCode: 200, data: [] }))
  const at = Date.parse('2026-10-05T06:03:00Z')
  assert.equal(service.claimNote(call(), at), null)
  assert.equal(service.claimNote(claimedCall('claimed'), at), '小周 正在处理 · 2 分钟前')
  assert.equal(service.claimNote(claimedCall('claimed', '2026-10-05T06:02:40Z'), at), '小周 正在处理 · 刚刚')
  assert.equal(
    service.claimNote(claimedCall('lapsed'), Date.parse('2026-10-05T06:13:00Z')),
    '小周 12 分钟前说去处理，还没处理',
  )
  // 认领人的账户不在了
  assert.equal(
    service.claimNote(claimedCall('claimed', undefined, { claimedBy: null }), at),
    '其他店员 正在处理 · 2 分钟前',
  )
  // 自己认领的写「你」，别人认领的照写昵称
  assert.equal(service.claimNote(claimedCall('claimed'), at, 'u-zhou'), '你正在处理 · 2 分钟前')
  assert.equal(
    service.claimNote(claimedCall('lapsed'), Date.parse('2026-10-05T06:13:00Z'), 'u-zhou'),
    '你 12 分钟前说去处理，还没处理',
  )
  assert.equal(service.claimNote(claimedCall('claimed'), at, 'u-li'), '小周 正在处理 · 2 分钟前')
})

test('工作台呼叫区：没人认领时「我去处理」「已处理」都在，有人认领着只留「已处理」；按钮文字 4 个字以内', () => {
  const workbench = fs.readFileSync(path.join(src, 'pages/staff/workbench/index.tsx'), 'utf8')
  assert.match(workbench, /seen\.current = alertKeys\(list\)/, '记下的是要提醒的键，认领着的不在里面')
  assert.match(workbench, /const claimed = call\.claimStatus === 'claimed'/)
  assert.match(workbench, /\{!claimed && \(\s*<Button[\s\S]*?>\s*我去处理\s*<\/Button>/)
  assert.match(workbench, /serviceCalls\.claim\(call\.id\)/)
  for (const label of workbench.matchAll(/>\s*(我去处理|已处理|知道了)\s*</g)) assert.ok([...label[1]].length <= 4)
  const styles = fs.readFileSync(path.join(src, 'pages/staff/workbench/index.scss'), 'utf8')
  assert.match(styles, /\.workbench-call-action \{[^}]*white-space: nowrap/, '4 个字的按钮不折行')
  const experience = fs.readFileSync(path.join(src, 'pages/customer/experience/index.tsx'), 'utf8')
  assert.match(experience, /state\.coming \? '店员正在过来' : '已呼叫，店员马上就到'/)
})

test('工作台只在页面显示时振动，回来先等重读；本次手作页不为呼叫另开实时连接', () => {
  const workbench = fs.readFileSync(path.join(src, 'pages/staff/workbench/index.tsx'), 'utf8')
  assert.match(workbench, /if \(fresh\.length > 0 && visible\) vibrate\(\)/)
  assert.match(workbench, /if \(!buzzing \|\| !visible\) return/)
  assert.match(workbench, /if \(readAt\.current < shownAt\.current\) return/)
  assert.match(workbench, /Taro\.vibrateLong\(\)\.catch\(\(\) => undefined\)/)
  assert.match(workbench, />\s*知道了\s*</)
  const experience = fs.readFileSync(path.join(src, 'pages/customer/experience/index.tsx'), 'utf8')
  assert.equal(experience.match(/live:\s*true/g)?.length, 1, '微信同时最多 5 条 socket，一页只开一条')
  assert.match(experience, /useCustomerQuery\(\['service-calls', 'me'\], serviceCalls\.mine/)
})
