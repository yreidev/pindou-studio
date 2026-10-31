import Taro from '@tarojs/taro'
import type { components } from '../api/schema'
import type { Account, Order } from './customer'
import { apiBase } from './api-base'
import { money } from './format'
export type { Account, AccountLabel, Order } from './customer'

type Schemas = components['schemas']
// ServiceTable、VenueSession 比契约宽松或只取部分字段，手写，由 api/contract-check.ts 核对。
export type ServiceTable = {
  seatBased?: boolean
  id: string
  floorAreaId: string
  number: number
  /** 布局里的稳定编码（A1、B3…）。平面图按它对位；桌号只在区域内唯一，靠不住。 */
  code?: string
  /** 分区字母，由 code 推出。 */
  zone?: string
  seatCount: number
  /** 整张桌一次只卖给一组客人（A 区双人位）。后端据此把整张桌一起锁住。 */
  wholeTable?: boolean
  enabled: boolean
  occupancy: 'idle' | 'occupied'
  timingStatus?: 'running' | 'expiring' | 'overdue'
  /** 桌上有自由计时的会话：没有结束时间，平面图上写「自由」。 */
  timingMode?: 'free'
  /** 桌上的会话都已停止计时、保留座位等结账（按座、整桌都算）：桌位页写「待结账」，不按 timingStatus 提醒。 */
  stopped?: true
  /**
   * 按当前计时与已发布套餐估出的应收，供会话页直接报价。
   *
   * ★ 缺这个字段的意思是「算不出来」（对不上套餐、自由计时、陪客、同桌多个会话），
   *   **不是**「不要钱」。后端刻意不下发 0，页面也要如实说「结账时填价」。
   */
  estimatedCents?: number
  /** 桌上只有一个会话时：后端算好的计价说明（超时加收几块、自由计时几块、陪客费），原样显示。 */
  charge?: Schemas['SessionCharge']
  remainingSeconds?: number
  startedAt?: string
  endsAt?: string
}
export type VenueSession = {
  id: string
  serviceTableId: string
  accountId?: string
  /** ended：系统内收费关着时店员点「结束」放座，没经过收款。 */
  status: 'active' | 'paused' | 'companion' | 'settled' | 'cancelled' | 'ended'
  startedAt: string
  timingMode: 'timed' | 'free'
  durationMinutes?: number
  /**
   * 顾客扫码申请、员工确认之后开出来的会话带这个。后端一直在返回，之前前端没声明。
   * 它的意思是「这次计时按套餐快照计价」：这类会话不能走 /venue-sessions PATCH
   * （后端 409），要走 loyalty.action；订单也不能改明细、不能人工折扣。
   */
  admissionId?: string
  /** 按座计时的座号；整桌开台没有。 */
  seatNumber?: number
  /** 已停止计时、保留座位等结账的时刻（按座会话、整桌会话都能停）；工作台的「快到点 / 已超时」不再提醒它。 */
  stoppedAt?: string
  /** 用到当天打烊（「到打烊」的套餐或整桌开到打烊）：结束时间固定在打烊，不能暂停、续时、标陪客、改时长或计时方式。 */
  untilClose?: true
  /** 整桌定时会话的续时方案（开台时记下的价，只在能续时、对得上套餐时给）：续时按它列「续 N 分钟」。 */
  renewal?: Schemas['ServiceTableSession']['renewal']
}
/** 改整桌会话的响应：会话，加上草稿订单有没有按新的计时改价（只在改了计时且已有草稿时给）。 */
export type SessionUpdate = VenueSession & Pick<Schemas['ServiceTableSessionUpdateResult'], 'draftOrder'>
/**
 * 续时后的提示：草稿已按新时长改价就报新应收；草稿明细被员工改过、没有自动改价，就要员工去结账页核对。
 * 没有草稿时为 null。
 */
export function draftOrderNotice(
  update: Pick<SessionUpdate, 'draftOrder'>,
): { repriced: boolean; text: string } | null {
  const draft = update.draftOrder
  if (!draft) return null
  const yuan = `¥${money(draft.receivableCents)}`
  return draft.repriced
    ? { repriced: true, text: `待结账订单已按新时长改为 ${yuan}` }
    : {
        repriced: false,
        text: `这一台的待结账订单明细被改过，没有按新时长自动改价（现在应收 ${yuan}）。请到结账页核对计时费。`,
      }
}
export type CatalogItem = Schemas['CatalogItem']
export const catalogLabel = (item: CatalogItem) => item.name || `未命名商品 · ${item.id.slice(0, 8)}`

const storageKey = 'pindou.customer.credential.v1'
const messageMap: Record<string, string> = {
  forbidden: '当前账号无权执行此操作',
  unauthorized: '登录已过期，请重新登录',
  last_owner: '系统必须保留至少一名老板',
  idempotency_required: '请求缺少幂等键',
  insufficient_stock: '库存不足',
  layout_locked: '请先解锁布局',
  table_occupied: '桌位当前正在使用',
  table_reserved: '该桌位还有未到店的预约，请先取消或改期再停用',
  confirmation_required: '请确认后继续',
  // 生日礼物核销（/loyalty/actions 的 fulfill_gift）：过期、已核销各有错误码，说法同后端
  birthday_gift_expired: '这份生日礼物已过期，不能再核销',
  birthday_gift_fulfilled: '这份生日礼物已经核销过了，不能重复核销',
}
messageMap.order_version_conflict = '订单已被修改，请重新读取并确认'
messageMap.idempotency_conflict = '请求内容与上次提交不一致，请重新读取订单'

export class StaffError extends Error {
  status: number
  code: string
  constructor(code: string, message: string, status = 0) {
    super(message)
    this.name = 'StaffError'
    this.code = code
    this.status = status
  }
}

const key = () => `miniapp-${Date.now()}-${Math.random().toString(36).slice(2)}`
const credential = () => Taro.getStorageSync(storageKey) as { accessToken?: string } | null

/**
 * 结果未知（断网、超时、5xx）的写请求，按「同一个动作」记下原请求体和原幂等键。
 *
 * ★ 以前按「人 + 方法 + 地址 + 请求体」复用键。请求体里带着版本号或当前库存，结果未知后页面一重读
 *   （实时事件、手动刷新），版本就变了，再点同一个按钮内容不同、换了新键，后端当成新操作再执行一次：
 *   看板续时扣两次、9 折打两次成 81 折。现在同一个动作先把上次那一条原样重发，弄清它到底生效没有：
 *   成功（后端重放出上次的结果，或这才执行）就告诉员工「上次已生效」、不再提交这一次；
 *   4xx 说明上次确实没生效，接着提交这一次；仍然未知就保留，等下次再试。
 */
type Unconfirmed = { body: string; data: unknown; key: string }
const unconfirmed = new Map<string, Unconfirmed>()

/** 只算不写的会员动作（结账报价、退款预览、规则计算示例）：不改数据，不必先确认上一次。 */
const readOnlyActions = new Set(['quote', 'refund_quote', 'preview_rule'])

/**
 * 「同一个动作」：同一人、同一方法和地址，请求体里同一种 action、同一个对象（targetId、accountId、
 * stockItemId、serviceTableId）。版本号、当前库存、金额这些不算——它们正是重读后会变的东西。
 * 只读动作返回 null，不参与。
 */
export function actionSlot(token: string, method: string, path: string, data: unknown): string | null {
  const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  if (typeof body.action === 'string' && readOnlyActions.has(body.action)) return null
  const pick = (name: string) => (typeof body[name] === 'string' ? body[name] : '')
  return JSON.stringify([
    token,
    method,
    path,
    pick('action'),
    pick('targetId'),
    pick('accountId'),
    pick('stockItemId'),
    pick('serviceTableId'),
  ])
}

/** 上次未确认的同一动作这回确认已经生效：这一次不再提交。 */
export const previousAppliedMessage =
  '上一次没收到结果的那次操作其实已经生效，这一次没有提交。请核对最新内容，需要的话再操作一次。'

type Delivered = Taro.request.SuccessCallbackResult<TaroGeneral.IAnyObject>

async function deliver(
  token: string,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  data: unknown,
  idempotencyKey: string,
  responseType?: 'text' | 'arraybuffer',
): Promise<Delivered> {
  try {
    return await Taro.request({
      url: `${apiBase.replace(/\/$/, '')}${path}`,
      method,
      data,
      timeout: 15000,
      responseType,
      header: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
    })
  } catch {
    throw new StaffError('network', '网络连接失败，请稍后重试')
  }
}

async function send<T>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  data?: unknown,
  idempotent = false,
  responseType?: 'text' | 'arraybuffer',
): Promise<{ data: T; header: Record<string, unknown> }> {
  const token = credential()?.accessToken
  if (!token) throw new StaffError('unauthorized', messageMap.unauthorized, 401)
  const slot = idempotent ? actionSlot(token, method, path, data) : null
  const body = JSON.stringify(data ?? null)
  let operationKey = idempotent ? key() : ''
  if (slot) {
    const previous = unconfirmed.get(slot)
    if (previous && previous.body !== body) {
      // 上次同一动作结果未知：先原样重发它（原请求体、原键），仍然未知就到此为止
      const replay = await deliver(token, path, method, previous.data, previous.key, responseType)
      if (replay.statusCode >= 500)
        throw new StaffError(`http_${replay.statusCode}`, '请求未完成，请稍后重试', replay.statusCode)
      unconfirmed.delete(slot)
      if (replay.statusCode >= 200 && replay.statusCode < 300)
        throw new StaffError('previous_applied', previousAppliedMessage, 409)
      // 4xx：上次确实没生效，接着提交这一次
    } else if (previous) operationKey = previous.key
    unconfirmed.set(slot, { body, data, key: operationKey })
  }
  const response = await deliver(token, path, method, data, operationKey, responseType)
  if (credential()?.accessToken !== token) throw new StaffError('session_changed', '身份已切换，请重新读取', 403)
  if (slot && response.statusCode < 500 && unconfirmed.get(slot)?.key === operationKey) unconfirmed.delete(slot)
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const payload = response.data as unknown as { code?: string; message?: string } | undefined
    const isPayment = method === 'POST' && /^\/sales-orders\/[^/]+\/payments$/.test(path)
    const code = payload?.code || `http_${response.statusCode}`
    if (isPayment && code === 'insufficient_stock')
      throw new StaffError(
        code,
        '商品库存不足，请先核对商品数量，并在电脑后台「商品与库存」登记采购入库；计时或服务费请选择自定义服务后保存明细',
        response.statusCode,
      )
    throw new StaffError(code, messageMap[code] || payload?.message || '请求未完成，请稍后重试', response.statusCode)
  }
  return { data: response.data as T, header: (response.header || {}) as Record<string, unknown> }
}

export async function request<T>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  data?: unknown,
  idempotent = false,
  responseType?: 'text' | 'arraybuffer',
): Promise<T> {
  return (await send<T>(path, method, data, idempotent, responseType)).data
}

/** 服务端分页的一页：总数与实际页码（从 1 起）来自响应头 X-Total-Count / X-Page。 */
export type Page<T> = { items: T[]; total: number; page: number }

// 响应头的大小写各端不一（真机常是全小写），按名字不分大小写取。
function headerNumber(header: Record<string, unknown>, name: string) {
  const key = Object.keys(header).find((value) => value.toLowerCase() === name.toLowerCase())
  const value = Number(key === undefined ? NaN : header[key])
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

/** 拼查询串；值一律转义。 */
export const queryString = (params: Record<string, string | number>) =>
  Object.entries(params)
    .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`)
    .join('&')

/**
 * 读一页服务端分页的数据。`items` 从响应体里取出这一页的条目（默认响应体就是数组）。
 * 响应头缺失时（不该发生）按「只有这一页」处理，不在前端编总数。
 */
export async function requestPage<T>(
  path: string,
  page: number,
  items: (data: unknown) => T[] = (data) => (Array.isArray(data) ? (data as T[]) : []),
): Promise<Page<T>> {
  const response = await send<unknown>(path)
  const list = items(response.data)
  return {
    items: list,
    total: headerNumber(response.header, 'X-Total-Count') ?? list.length,
    page: headerNumber(response.header, 'X-Page') || page,
  }
}

/** 关键字最长 100 字（契约上限），去掉首尾空白。 */
export const searchKeyword = (value: string) => value.trim().slice(0, 100)

export const staffApi = {
  /**
   * 员工找顾客：服务端按昵称、打码手机号、账户编号开头或完整手机号筛选，新注册的在前。
   */
  searchAccounts: (keyword: string, page = 1, pageSize = 20) =>
    requestPage<Account>(`/accounts?${queryString({ q: searchKeyword(keyword), page, pageSize })}`, page),
  getAccount: (id: string) => request<Account>(`/accounts/${encodeURIComponent(id)}`),
  /**
   * 给顾客发认领用的一次性临时密码：8 位数字，24 小时内有效，顾客在小程序登录页「店员帮我开过会员，去认领」里
   * 用手机号加它认领；原来的认领密码作废。只在这次响应里出现，不另存。
   * 店员只能给顾客发，给员工发要能管理对方的角色，后端判断。
   */
  issueTemporaryPassword: (id: string) =>
    request<Schemas['PasswordReset']>(`/accounts/${encodeURIComponent(id)}/password-resets`, 'POST'),
  listTables: () => request<ServiceTable[]>('/service-tables'),
  // ★ 布局固定之后这是员工端唯一还能改的桌位状态。后端对其余字段一律回 400 layout_fixed
  //   —— 静默忽略会让店员以为改成功了，下次重启 ReconcileLayout 又改回去。
  updateTable: (id: string, data: Required<Schemas['ServiceTableUpdateInput']>) =>
    request<ServiceTable>(`/service-tables/${encodeURIComponent(id)}`, 'PATCH', data, true),
  /** 只取进行中的会话（计时中、暂停、陪客）：全部历史会越积越大。 */
  listLiveSessions: () => request<VenueSession[]>('/venue-sessions?status=live'),
  getSession: (id: string) => request<VenueSession>(`/venue-sessions/${encodeURIComponent(id)}`),
  createSession: (data: Schemas['ServiceTableSessionInput']) =>
    request<VenueSession>('/venue-sessions', 'POST', data, true),
  /**
   * 整桌会话的暂停、继续、陪客、换桌、续时、停止计时（stop: true，单独提交）。续时用 extendMinutes +
   * expectedDurationMinutes（看到的时长），不再发「读到的时长 + N」的绝对值：两人同时续或页面过期时后端回 409，
   * 不会互相覆盖、把时长改短。改了计时且这一台已有草稿时，响应的 draftOrder 说明草稿跟着改价了没有。
   * 都带幂等键（续时、停止计时后端必须要）。
   */
  updateSession: (id: string, data: Schemas['ServiceTableSessionUpdateInput']) =>
    request<SessionUpdate>(`/venue-sessions/${encodeURIComponent(id)}`, 'PATCH', data, true),
  cancelSession: (id: string) => request<void>(`/venue-sessions/${encodeURIComponent(id)}`, 'DELETE', undefined, true),
  /**
   * 只取待结账的单（status=open：草稿和部分付款，还没收齐的都在内）：员工端只在订单收款和工作台用到；
   * 历史订单在电脑后台按页查。
   */
  listDraftOrders: () => request<Order[]>('/sales-orders?status=open'),
  getOrder: (id: string) => request<Order>(`/sales-orders/${encodeURIComponent(id)}`),
  createOrder: (data: Schemas['OrderInput']) => request<Order>('/sales-orders', 'POST', data, true),
  updateOrder: (id: string, lines: Schemas['OrderLine'][], expectedVersion: string) =>
    request<Order>(`/sales-orders/${encodeURIComponent(id)}`, 'PATCH', { lines, expectedVersion }, true),
  /**
   * 收一笔线下款（多人合付可以分几笔）：金额 1 分起、不超过读到的还差的数（outstandingCents），等于它就收齐结清，
   * 少于它订单为部分付款。现金可带选填的实收现金（整数分），后端按这一笔算出找零记在付款记录上；
   * 不填就不带这个字段（请求和以前一样）。
   */
  payOrder: (
    id: string,
    method: Schemas['PaymentInput']['method'],
    amountCents: number,
    expectedVersion: string,
    cashReceivedCents?: number,
  ) =>
    request<Order>(
      `/sales-orders/${encodeURIComponent(id)}/payments`,
      'POST',
      {
        method,
        amountCents,
        expectedVersion,
        ...(cashReceivedCents === undefined ? {} : { cashReceivedCents }),
      } satisfies Schemas['PaymentInput'],
      true,
    ),
  /**
   * 给待结账订单绑定、更换顾客账户，或改成散客（accountId 为 null）；所有员工都可以。带读到的订单版本，
   * 过期 409 由页面提示重读、员工再确认。换了顾客订单版本跟着变，之前的会员报价作废。套餐订单后端回 409 loyalty_conflict。
   */
  setOrderCustomer: (id: string, accountId: string | null, expectedVersion: string) =>
    request<Order>(
      `/sales-orders/${encodeURIComponent(id)}/customer`,
      'PATCH',
      { accountId, expectedVersion } satisfies Schemas['OrderCustomerInput'],
      true,
    ),
  discountOrder: (id: string, data: Omit<Schemas['OrderDiscountInput'], 'expectedVersion'>, expectedVersion: string) =>
    request<Order>(`/sales-orders/${encodeURIComponent(id)}/discounts`, 'POST', { ...data, expectedVersion }, true),
  /**
   * 免单（店长、老板）：这一单不收钱（或分笔付款收了一部分后，剩下的不收了），直接结清，必须写原因。记成一条免单
   * 结清记录（不是 100% 折扣），金额是读到的还差的数；应收照旧、免掉的部分不能退款。计时费随时间变了、别人刚收了
   * 一笔都会 409，重读再确认。
   */
  compOrder: (id: string, reason: string, expectedVersion: string) =>
    request<Order>(
      `/sales-orders/${encodeURIComponent(id)}/comps`,
      'POST',
      { reason, expectedVersion } satisfies Schemas['CompInput'],
      true,
    ),
  listCatalog: () => request<CatalogItem[]>('/catalog-items'),
}

export const staffMessage = (error: unknown) => (error instanceof Error ? error.message : '网络连接失败，请稍后重试')
