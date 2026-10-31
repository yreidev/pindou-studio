import assert from 'node:assert/strict'
import { environmentManager } from '@tanstack/react-query'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { useCustomerQuery, useStaffQuery } from '../src/hooks/query'
import { CustomerError } from '../src/services/customer'
import { createQueryClient } from '../src/services/query'
import { StaffError } from '../src/services/staff'
import { events, page, session } from './helpers/live'
import { cleanup, flush, renderHook } from './helpers/render'

vi.mock('@tarojs/taro', async () => (await import('./helpers/live')).taroModule)
vi.mock('../src/services/platform', async () => (await import('./helpers/live')).platformModule)
vi.mock('../src/services/events', async () => (await import('./helpers/live')).eventsModule)

// 读数据的规则（docs/development.md「小程序交互与视觉」）：刷新不清空现有内容；网络刷新失败保留上次内容并
// 明确提示；401/403/404 不保留受限资源；身份变了旧内容立即不显示，迟到的旧响应不能盖回来。

environmentManager.setIsServer(() => false)
beforeEach(() => {
  session.reset()
  events.reset()
})
afterEach(cleanup)

test('role changes hide cached staff resources immediately and discard the previous request', async () => {
  const client = createQueryClient()
  const pending: ((value: string[]) => void)[] = []
  let delayed = false
  const load = () => (delayed ? new Promise<string[]>((done) => pending.push(done)) : Promise.resolve(['private']))
  const view = renderHook(() => useStaffQuery(['tables'], load), client, undefined)
  await flush()
  assert.deepEqual(view.result.current.data, ['private'])
  delayed = true
  view.result.current.refresh()
  await flush()
  assert.equal(pending.length, 1, '刷新已经发出、还没回来')
  session.changeRole('manager')
  assert.equal(view.result.current.data, null, '换了角色，上一个角色读到的内容当场不显示')
  pending[0](['old role result'])
  await flush()
  assert.equal(view.result.current.data, null, '换角色之前发出的请求回来了也不能显示')
  // 新角色自己的那次读回来才显示
  pending.at(-1)!(['manager view'])
  await flush()
  assert.deepEqual(view.result.current.data, ['manager view'])
})

test('staff refresh keeps last data after network failure, recovers, and clears it after permission failure or signout', async () => {
  const client = createQueryClient()
  let result: unknown = [{ id: 'table', occupancy: 'occupied' }],
    failure: unknown,
    reads = 0
  const load = async () => {
    reads++
    if (failure) throw failure
    return result
  }
  const view = renderHook(() => useStaffQuery(['tables'], load), client, undefined)
  const state = () => view.result.current
  await flush()
  assert.deepEqual(state().data, result)
  failure = new StaffError('network', '网络连接失败，请稍后重试')
  state().refresh()
  await flush()
  assert.deepEqual(state().data, result, '断网时保留上次的内容')
  assert.equal(state().error, failure, '并且说明刷新失败了')
  assert.equal(state().loading, false)
  failure = undefined
  result = [{ id: 'table', occupancy: 'idle' }]
  state().refresh()
  await flush()
  assert.deepEqual(state().data, result)
  assert.equal(state().error, null)
  failure = new StaffError('forbidden', '当前账号无权执行此操作', 403)
  state().refresh()
  await flush()
  assert.equal(state().data, null, '无权时不留受限内容')
  failure = new StaffError('network', '网络连接失败，请稍后重试')
  state().refresh()
  await flush()
  assert.equal(state().data, null, '之后断网也不能把无权之前的内容找回来')
  failure = undefined
  state().refresh()
  await flush()
  assert.deepEqual(state().data, result)
  session.signOut()
  assert.equal(state().data, null, '退出登录立即不显示')
  const before = reads
  state().refresh()
  await flush()
  assert.equal(state().data, null)
  assert.equal(reads, before, '没有员工身份不发请求')
})

test('customer refresh preserves orders on network failure but hides them after access is revoked', async () => {
  session.reset([])
  const client = createQueryClient()
  const orders = [{ id: 'order' }]
  let failure: unknown
  const load = async () => {
    if (failure) throw failure
    return orders
  }
  const view = renderHook(() => useCustomerQuery(['sales-orders'], load), client, undefined)
  const state = () => view.result.current
  await flush()
  assert.deepEqual(state().data, orders)
  failure = new CustomerError('network', '网络连接失败，请稍后重试')
  await state().refresh()
  await flush()
  assert.deepEqual(state().data, orders)
  assert.equal(state().error, failure)
  failure = new CustomerError('forbidden', '当前账号无权查看此内容', 403)
  await state().refresh()
  await flush()
  assert.equal(state().data, null)
})

test('a page reads again when it is shown again, not while it is hidden', async () => {
  const client = createQueryClient()
  let reads = 0
  const view = renderHook(() => useStaffQuery(['tables'], async () => ++reads), client, undefined)
  await flush()
  assert.equal(reads, 1)
  page.hide()
  // 页面不显示时，数据变了也只是记下过期，不读
  view.result.current.refresh()
  await flush()
  assert.equal(reads, 1, '不显示的页面不重读')
  page.show()
  await flush()
  assert.equal(reads, 2, '回到页面立即重读')
  assert.equal(view.result.current.data, 2)
})

test('a refresh while a read is in flight waits for it and reads once more afterwards', async () => {
  const client = createQueryClient()
  const pending: ((value: number) => void)[] = []
  const view = renderHook(
    () => useStaffQuery(['tables'], () => new Promise<number>((done) => pending.push(done))),
    client,
    undefined,
  )
  await flush()
  assert.equal(pending.length, 1)
  // 那次读在途时又来了两次刷新（事件、写操作之后）：不并发再发，等它回来再补读一次
  view.result.current.refresh()
  view.result.current.refresh()
  await flush()
  assert.equal(pending.length, 1, '在途时不并发再发一批')
  pending[0](1)
  await flush()
  assert.equal(pending.length, 2, '在途的那次可能早于这次变化，回来后补读一次')
  pending[1](2)
  await flush()
  assert.equal(pending.length, 2, '只补一次')
  assert.equal(view.result.current.data, 2)
})
