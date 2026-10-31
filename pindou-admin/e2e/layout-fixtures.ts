import { accountListResult, memberListResult } from './account-list'
import type { MockHandler } from './mock-api'
import { orderListResult } from './order-list'

// 版式测试用的「满」数据：长昵称、长商品名、长原因、几十条记录、负数金额，用来暴露截断与溢出。
// 只给读取接口；结构照 docs/api.yaml 与 src/api/*.ts。

const uuid = (prefix: string, n: number) =>
  `${prefix.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 10, minute = 0) => new Date(Date.UTC(2026, 8, day, hour - 8, minute)).toISOString()

export const ownerId = uuid('aaaaaaaa', 1)

const nicknames = [
  '阿贝',
  '超长昵称的老顾客小王同学Sama',
  '李',
  '周末常来拼豆的大学生团体负责人',
  'Rainbow 彩虹豆豆',
  '店长小林',
]
export const accounts = nicknames.map((nickname, i) => ({
  id: i === 0 ? ownerId : uuid('bbbbbbbb', i + 1),
  nickname,
  roles: i === 0 ? ['owner'] : i === 5 ? ['manager'] : [],
  phoneVerificationStatus: 'verified',
  phoneMasked: `13${i}****${String(1000 + i * 1111).slice(0, 4)}`,
}))
/** 列表里服务端带的称呼（AccountLabel）。 */
const labelOf = (id: string | undefined) => {
  const account = accounts.find((a) => a.id === id)
  return account ? { id: account.id, nickname: account.nickname, phoneMasked: account.phoneMasked } : null
}

const productNames = [
  '日本进口高级透明拼豆 5mm 1000 颗装（混色）',
  '拼豆板 方形',
  '熨烫纸',
  '钥匙扣配件（金色，带链条与 D 字扣）',
  '亚克力展示框 20×20cm',
  '镊子',
  '夜光拼豆 2.6mm 迷你款 500 颗装',
  '包装袋',
  '拼豆图纸 · 动漫人物系列第三辑（限量）',
  '耳环钩',
  '冰箱贴磁铁',
  '收纳盒 24 格',
]
export const catalog = productNames.map((name, i) => ({
  id: uuid('cccccccc', i + 1),
  name,
  unitPriceCents: 500 + i * 1350,
}))
export const stock = catalog.map((item, i) => ({
  id: uuid('dddddddd', i + 1),
  productId: item.id,
  quantity: i % 4 === 0 ? 0 : 3 + i * 17,
  alertAt: i % 3 === 0 ? 10 : 0,
  lowStock: i % 4 === 0,
}))
const movementKinds = ['purchase', 'adjustment', 'sale', 'refund', 'loyalty'] as const
export const movements = Array.from({ length: 40 }, (_, i) => {
  const kind = movementKinds[i % movementKinds.length]
  const s = stock[i % stock.length]
  return {
    id: uuid('eeeeeeee', i + 1),
    stockItemId: s.id,
    productId: s.productId,
    kind,
    quantityDelta: kind === 'sale' || kind === 'loyalty' ? -((i % 5) + 1) : (i % 7) + 1,
    createdAt: at(1 + (i % 28), 9 + (i % 10), i),
    // 操作人用长昵称，检查窄屏下这一列不把别的列挤窄；每隔几条留一条没有操作人的早期流水
    ...(i % 4 === 3 ? {} : { actorId: ownerId, actorName: '超长昵称的老板阿贝（周末店长代班）' }),
    ...(kind === 'adjustment' ? { reason: '月底盘点发现少了几包，可能是展示时被顾客拆开用掉了，已和店员核对' } : {}),
    ...(kind === 'purchase'
      ? {
          supplierName: '义乌小商品城拼豆批发三号档口（王老板）',
          note: '含运费，下次记得要发票',
          referenceId: uuid('ffffffff', i),
        }
      : { referenceId: uuid('99999999', i) }),
  }
})

const statuses = ['draft', 'paid', 'paid', 'refunded', 'voided'] as const
const line = (i: number) => ({
  productId: catalog[i % catalog.length].id,
  name: catalog[i % catalog.length].name,
  quantity: 1 + (i % 3),
  unitPriceCents: catalog[i % catalog.length].unitPriceCents,
})
export const orders = Array.from({ length: 30 }, (_, i) => {
  const status = statuses[i % statuses.length]
  const lines = [
    line(i),
    line(i + 1),
    { name: '三小时计时畅玩（含材料与工具，超时按半小时计）', quantity: 1, unitPriceCents: 6880 },
  ]
  const receivable = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0)
  const paid = status === 'draft' || status === 'voided' ? 0 : receivable
  const refunded = status === 'refunded' ? receivable : i % 7 === 1 ? 1000 : 0
  const member = i % 6 === 2
  const accountId = i % 2 === 0 ? accounts[(i % 5) + 1].id : undefined
  return {
    id: uuid('12345678', i + 1),
    version: 'v'.repeat(64),
    accountId,
    customer: labelOf(accountId),
    status,
    receivableCents: receivable,
    paidCents: paid,
    refundedCents: refunded,
    refundableCents: paid - refunded,
    settlement: member ? 'member' : 'standard',
    ...(member
      ? {
          memberCheckout: {
            principalCents: 5000,
            giftCents: 1200,
            pointsUsed: 300,
            pointsEarned: 88,
            offlineCents: Math.max(0, paid - 6200),
          },
        }
      : {}),
    createdAt: at(1 + (i % 28), 13, i),
    lines,
    discounts:
      i % 3 === 0
        ? [
            {
              id: uuid('d1d1d1d1', i),
              kind: 'percentage',
              rateBasisPoints: 1250,
              reason: '老顾客带新朋友来，按店长口头承诺打八七五折',
              createdAt: at(1 + (i % 28), 13, 30),
            },
          ]
        : [],
    payments: paid
      ? [
          {
            id: uuid('p1p1p1p1', i),
            method: member ? 'balance' : 'wechat',
            amountCents: paid,
            createdAt: at(1 + (i % 28), 14, 0),
          },
        ]
      : [],
    refunds: refunded
      ? [
          {
            id: uuid('r1r1r1r1', i),
            reason: '顾客说颜色和图纸不一致，退回一包材料并道歉',
            amountCents: refunded,
            returnedProducts: { [line(i).productId]: 1 },
            createdAt: at(1 + (i % 28), 16, 0),
          },
        ]
      : [],
  }
})

const rule = (kind: string, n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid('a0a0a0a0', n),
  kind,
  name: `${kind} 规则：周末亲子拼豆体验专享（含材料）第 ${n} 版`,
  enabled: true,
  amountCents: 10000,
  giftCents: 1000,
  points: 100,
  rateBasisPoints: 9500,
  maxBasisPoints: 3000,
  minimumPoints: 100,
  validDays: 365,
  mode: kind === 'tier' ? 'cumulative' : kind === 'birthday' ? 'month' : '',
  scope: kind === 'earn' ? 'all' : kind === 'birthday' ? 'points' : '',
  stack: false,
  productId: kind === 'exchange' ? catalog[3].id : '',
  quantity: kind === 'exchange' ? 50 : 0,
  perUserLimit: kind === 'exchange' ? 2 : 0,
  durationMinutes: kind === 'package' ? 180 : 0,
  renewalMinutes: kind === 'package' ? 30 : 0,
  renewalCents: kind === 'package' ? 1500 : 0,
  pauseLimitMinutes: kind === 'package' ? 20 : 0,
  overtime: kind === 'package' ? 'manual' : '',
  ...extra,
})
const ruleKindList = ['tier', 'recharge', 'earn', 'redeem', 'exchange', 'birthday', 'package']
const liveRules = ruleKindList.map((kind, i) => rule(kind, i + 1))
const drafts = Object.fromEntries(
  [...liveRules, rule('recharge', 20, { enabled: false, name: '国庆充 500 送 80（草稿，未发布）' })].map((r) => [
    r.id,
    r,
  ]),
)
const publications = liveRules.map((r, i) => ({
  id: uuid('b0b0b0b0', i + 1),
  rule: r,
  actorId: ownerId,
  actor: labelOf(ownerId),
  createdAt: at(2 + i, 10),
  impact: '新规则只影响发布之后的交易；已充值的余额、已获得的积分和已购买的套餐保持原样不变。',
}))

const balance = (i: number) => ({
  principalCents: 123456 - i * 10000,
  giftCents: 8800,
  points: 12345,
  expiringPoints: 300,
  boardUses: 2,
  tierName: i % 2 ? '金卡会员（累计消费满 2000 元）' : '普通会员',
  rateBasisPoints: 9500,
})
// 会员列表在服务端分页（每页 10 位），多给一些让左边窄栏里出现分页条
const loyaltyAccounts = [
  ...accounts.map((a, i) => ({ id: a.id, nickname: a.nickname, phoneMasked: a.phoneMasked, balance: balance(i) })),
  ...Array.from({ length: 18 }, (_, i) => ({
    id: uuid('b2b2b2b2', i + 1),
    nickname: `周末亲子拼豆班学员家长${i + 1}号`,
    phoneMasked: i % 3 ? `15${i % 10}****${String(2000 + i).slice(0, 4)}` : '',
    balance: balance(i),
  })),
]
const entryKinds = ['recharge', 'checkout', 'earned', 'adjust', 'refund', 'exchange', 'birthday'] as const
const memberEntries = Array.from({ length: 25 }, (_, i) => {
  const kind = entryKinds[i % entryKinds.length]
  return {
    id: uuid('c0c0c0c0', i + 1),
    accountId: accounts[1].id,
    kind,
    sourceId: kind === 'recharge' ? liveRules[1].id : orders[i % orders.length].id,
    reason: kind === 'adjust' ? '10 月 2 日充值时本金多录了 20 元，按顾客确认后扣回并记录' : '',
    method: kind === 'recharge' ? 'wechat' : undefined,
    principalCents: kind === 'checkout' ? -5000 : kind === 'recharge' ? 50000 : kind === 'adjust' ? -2000 : 0,
    giftCents: kind === 'recharge' ? 5000 : kind === 'checkout' ? -1200 : 0,
    points:
      kind === 'earned' || kind === 'recharge'
        ? [{ lotId: uuid('l0l0l0l0', i), delta: 188, expiresAt: at(28, 10) }]
        : kind === 'checkout'
          ? [{ lotId: uuid('l0l0l0l0', i), delta: -300 }]
          : null,
    rule:
      kind === 'recharge'
        ? {
            id: liveRules[1].id,
            kind: 'recharge',
            name: liveRules[1].name,
            amountCents: 50000,
            giftCents: 5000,
            points: 188,
          }
        : undefined,
    createdAt: at(1 + (i % 28), 11, i),
  }
})

// 一份待核销的生日礼物（柜台三项里的「生日礼物核销」）
const giftEntry = {
  id: uuid('c1c1c1c1', 1),
  accountId: accounts[1].id,
  kind: 'birthday',
  sourceId: uuid('a0a0a0a0', 22),
  reason: '',
  principalCents: 0,
  giftCents: 0,
  points: [],
  rule: rule('birthday', 22, { scope: 'gift', name: '生日礼物：定制拼豆钥匙扣（含名字刻字）一份' }),
  createdAt: at(5, 15),
}

const areaNames = ['A 区（靠窗双人位）', 'B 区', 'C 区（大桌）', 'D 区']
const areas = areaNames.map((name, i) => ({ id: uuid('a1a1a1a1', i + 1), name }))
const tables = areas.flatMap((area, ai) =>
  Array.from({ length: 5 }, (_, ti) => ({
    id: uuid('t1t1t1t1', ai * 5 + ti + 1),
    floorAreaId: area.id,
    number: ti + 1,
    code: `${'ABCD'[ai]}${ti + 1}`,
    zone: 'ABCD'[ai],
    seatCount: ai === 0 ? 2 : 4 + ti,
    wholeTable: ai === 0,
    enabled: !(ai === 1 && ti === 2),
    occupancy: 'idle',
  })),
)

// 「预约」页：还要处理的几条（长称呼、长备注、各种状态）和处理完的一长串（服务端分页）；时间按此刻现算
const reservationTables = tables
  .filter((table) => table.enabled)
  .map((table, i) => ({
    id: table.id,
    code: table.code,
    zone: table.zone,
    number: table.number,
    seatCount: table.seatCount,
    wholeTable: table.wholeTable,
    occupiedSeats: [],
    floorAreaId: table.floorAreaId,
    floorAreaName: areaNames[Math.floor(i / 5)] ?? 'D 区',
  }))
const packageRule = liveRules.find((r) => r.kind === 'package')!
const reservationEntry = (i: number, startsIn: number, displayStatus: string) => {
  const startAt = new Date(Date.now() + startsIn * 60_000).toISOString()
  const account = i % 3 ? accounts[i % accounts.length] : undefined
  const table = reservationTables[i % reservationTables.length]
  return {
    reservation: {
      id: uuid('r0r0r0r0', i + 1),
      ...(account ? { accountId: account.id } : { guestName: '周末带孩子来的王阿姨' }),
      serviceTableId: table.id,
      seatNumber: 1,
      packageId: packageRule.id,
      packageName: packageRule.name,
      durationMinutes: 180,
      amountCents: 12800,
      startAt,
      status: displayStatus === 'expired' ? 'confirmed' : displayStatus,
      ...(i % 2 ? { note: '两位大人一位小朋友，小朋友第一次做拼豆，希望安排靠窗的位置并准备儿童镊子' } : {}),
      ...(displayStatus === 'cancelled' ? { reason: '顾客来电说孩子临时发烧，改到下周末再来，已提醒重新预约' } : {}),
      createdBy: account && i % 2 ? account.id : ownerId,
      createdAt: at(1, 9),
    },
    displayStatus,
    endAt: new Date(Date.parse(startAt) + 180 * 60_000).toISOString(),
    tableNumber: table.number,
    customerName: account ? account.nickname : '周末带孩子来的王阿姨',
    ...(account ? { phoneMasked: account.phoneMasked } : {}),
  }
}
const openReservations = [
  reservationEntry(0, -120, 'expired'),
  reservationEntry(1, 15, 'confirmed'),
  reservationEntry(2, 40, 'pending'),
  reservationEntry(3, 90, 'confirmed'),
  reservationEntry(4, 24 * 60, 'pending'),
  reservationEntry(5, 2 * 24 * 60 + 30, 'confirmed'),
]
const endedReservations = Array.from({ length: 30 }, (_, i) =>
  reservationEntry(10 + i, -(i + 1) * 24 * 60, ['seated', 'cancelled', 'no_show'][i % 3]),
)

const auditActions = [
  'order.paid',
  'order.refunded',
  'stock.purchase.created',
  'stock.adjusted',
  'role.assigned',
  'web_login.approved',
  'loyalty.rule.published',
  'backup.created',
]
const audits = Array.from({ length: 40 }, (_, i) => ({
  id: uuid('a2a2a2a2', i + 1),
  action: auditActions[i % auditActions.length],
  objectId: uuid('99999999', i + 1),
  reason: i % 3 === 0 ? '顾客说颜色和图纸不一致，退回一包材料并道歉，店长现场确认' : '',
  accountId: accounts[i % accounts.length].id,
  actor: labelOf(accounts[i % accounts.length].id),
  requestId: uuid('a3a3a3a3', i),
  createdAt: at(1 + (i % 28), 10 + (i % 8), i),
}))
const roleAssignments = accounts
  .filter((a) => a.roles.length)
  .map((a, i) => ({
    id: uuid('a5a5a5a5', i + 1),
    accountId: a.id,
    account: labelOf(a.id),
    role: a.roles[0],
    assignedAt: at(1, 10),
  }))

const settings = {
  enabled: true,
  openMinute: 600,
  closeMinute: 1320,
  slotMinutes: 30,
  advanceDays: 14,
  leadMinutes: 30,
  graceMinutes: 15,
  // 歇业日期给得满一些，看标签换行
  closedDates: ['2026-12-24', '2026-12-25', '2026-12-31', '2027-01-01', '2027-02-16', '2027-02-17', '2027-02-18'],
  closedWeekdays: [1],
  noShowLimit: 3,
  noShowWindowDays: 30,
}

/** 版式测试的模拟接口：只读，写请求一律回 404（版式测试不提交）。 */
export const layoutBackend: MockHandler = ({ method, path, search }) => {
  if (method !== 'GET') return undefined
  const ok = (body: unknown) => ({ status: 200, body })
  if (path === '/accounts') return accountListResult(accounts, search)
  if (path.startsWith('/accounts/')) return ok(accounts.find((a) => path.endsWith(a.id)) ?? accounts[0])
  if (path === '/staff-role-assignments') return ok(roleAssignments)
  if (path === '/sales-orders') return orderListResult(orders, search)
  const orderMatch = path.match(/^\/sales-orders\/([^/]+)$/)
  if (orderMatch) return ok(orders.find((o) => o.id === orderMatch[1]) ?? orders[1])
  if (path === '/catalog-items') return ok(catalog)
  if (path === '/stock-items') return ok(stock)
  if (path.startsWith('/stock-movements')) return ok(movements)
  if (path === '/loyalty/members') return memberListResult(loyaltyAccounts, search)
  if (path === '/loyalty/settings') return ok({ drafts, rules: liveRules, publications, version: 'r'.repeat(64) })
  if (path.startsWith('/loyalty/account'))
    return ok({
      balance: balance(1),
      profile: { birthday: '10-05', birthdayYear: 2026 },
      entries: [...memberEntries, giftEntry],
      // 柜台三项按已发布规则列充值方案、兑换商品；再加一份同类方案，看多行时的版式
      rules: [...liveRules, rule('recharge', 21, { amountCents: 100000000, giftCents: 15000000, points: 1000000 })],
      admissions: [],
      version: 'm'.repeat(64),
    })
  if (path === '/reservations/staff' && search.get('scope') === 'open')
    return ok({
      reservations: openReservations,
      busy: [],
      packages: [packageRule],
      tables: reservationTables,
      settings,
      settingsVersion: 's'.repeat(64),
      closedDays: [],
      version: 'x'.repeat(64),
    })
  if (path === '/reservations/staff' && search.get('scope') === 'ended') {
    const size = Number(search.get('pageSize')) || 20
    const page = Math.min(Math.max(1, Number(search.get('page')) || 1), Math.ceil(endedReservations.length / size))
    return {
      status: 200,
      body: {
        reservations: endedReservations.slice((page - 1) * size, page * size),
        busy: [],
        packages: [packageRule],
        tables: reservationTables,
        settings,
        settingsVersion: 's'.repeat(64),
        closedDays: [],
        version: 'y'.repeat(64),
      },
      headers: { 'X-Total-Count': String(endedReservations.length), 'X-Page': String(page) },
    }
  }
  if (path === '/floor-areas') return ok(areas)
  if (path === '/service-tables') return ok(tables)
  if (path === '/system/audit-events') return ok(audits)
  return undefined
}

export const sampleOrderId = orders[1].id
export const sampleMemberOrderId = orders[2].id
export const sampleMemberId = accounts[1].id
