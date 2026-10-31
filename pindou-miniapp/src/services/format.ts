import type { Order } from './customer'

export function money(cents: number): string {
  if (!Number.isSafeInteger(cents)) return '--'
  const value = String(cents < 0 ? -cents : cents).padStart(3, '0')
  return `${cents < 0 ? '-' : ''}${value.slice(0, -2)}.${value.slice(-2)}`
}

/** 给人看的金额：「1,008.00」，三位一逗号。输入框的初值仍用 money（不带逗号，能直接改）。 */
export function moneyText(cents: number): string {
  const plain = money(cents)
  if (plain === '--') return plain
  const [whole, fraction] = plain.split('.')
  return `${whole.replace(/\B(?=(\d{3})+$)/g, ',')}.${fraction}`
}

export const orderLabels: Record<Order['status'], string> = {
  draft: '待结账',
  // 分笔付款收了一部分、还没收齐
  partially_paid: '部分付款',
  paid: '已付款',
  refunded: '已退款',
  voided: '已撤销',
}
// comp 是免单：不是收到的钱，记的是免掉的金额
export const paymentLabels = { cash: '现金', wechat: '微信', alipay: '支付宝', balance: '储值余额', comp: '免单' }

/** 还没收齐的单（待结账、部分付款）：员工的「待结账」、顾客的「待结账」筛选都含部分付款。 */
export const isOpenOrder = (order: Pick<Order, 'status'>) =>
  order.status === 'draft' || order.status === 'partially_paid'

/**
 * 订单卡片与详情上那一个金额：待结账写应收；部分付款写已付（后面写还差多少，接口给的 outstandingCents）；
 * 其余写实付，整单免单的注明。金额都是接口的数，不加减。
 */
export function orderAmount(
  order: Pick<Order, 'status' | 'receivableCents' | 'paidCents' | 'outstandingCents' | 'settlement'>,
): {
  label: string
  cents: number
} {
  if (order.status === 'draft') return { label: '应收金额', cents: order.receivableCents }
  if (order.status === 'partially_paid')
    return {
      label:
        order.outstandingCents === undefined
          ? '已付金额（部分付款）'
          : `已付金额（部分付款，还差 ¥${money(order.outstandingCents)}）`,
      cents: order.paidCents,
    }
  return { label: order.settlement === 'comp' ? '实付金额（已免单）' : '实付金额', cents: order.paidCents }
}

/**
 * 员工待结账列表上那一个金额：草稿写应收；部分付款（分笔付款收了一部分）写还差多少——接口给的 outstandingCents，
 * 不在本地拿应收减已收。重放的旧响应没有它时只写已收多少。
 */
export function pendingAmount(order: Pick<Order, 'status' | 'receivableCents' | 'paidCents' | 'outstandingCents'>): {
  cents: number
  label: string
  /** 读屏念的一句。 */
  text: string
} {
  if (order.status !== 'partially_paid')
    return { cents: order.receivableCents, label: '应收', text: `应收 ${money(order.receivableCents)} 元` }
  if (order.outstandingCents === undefined)
    return { cents: order.paidCents, label: '部分付款 · 已收', text: `部分付款，已收 ${money(order.paidCents)} 元` }
  return {
    cents: order.outstandingCents,
    label: '部分付款 · 还差',
    text: `部分付款，还差 ${money(order.outstandingCents)} 元`,
  }
}
export const orderTitle = (order: Order) => order.lines?.find((line) => line.name)?.name || '门店消费订单'

/**
 * 门店时区（中国标准时间，没有夏令时）比 UTC 早的分钟数。时间一律按门店时区显示和输入，不跟手机的时区走：
 * 同一条记录在小程序和网页后台上显示的时刻一致，出门在外、手机时区不对时也不会把营业时间看错。
 */
export const storeOffsetMinutes = 8 * 60

// 统一用这三个而不是 toLocaleString：后者的输出随设备和微信运行时的区域数据变化，
// 同一条记录在不同手机上可能显示成不同格式。
const part = (value: number) => String(value).padStart(2, '0')
// 挪到门店时区后读 UTC 字段，就是门店墙上的钟
const parse = (value: string | number) => {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() + storeOffsetMinutes * 60000) : null
}

export function dateTime(value: string | number): string {
  const t = parse(value)
  if (!t) return '--'
  return `${t.getUTCFullYear()}-${part(t.getUTCMonth() + 1)}-${part(t.getUTCDate())} ${part(t.getUTCHours())}:${part(t.getUTCMinutes())}`
}

export function dateOnly(value: string | number): string {
  const t = parse(value)
  if (!t) return '--'
  return `${t.getUTCFullYear()}-${part(t.getUTCMonth() + 1)}-${part(t.getUTCDate())}`
}

export function clockTime(value: string | number): string {
  const t = parse(value)
  if (!t) return '--'
  return `${part(t.getUTCHours())}:${part(t.getUTCMinutes())}:${part(t.getUTCSeconds())}`
}

/** 整数基点 → 百分比文字，例如 1250 → "12.5%"。只用整数运算，不经过浮点。 */
export function basisPoints(value: number): string {
  const whole = Math.trunc(value / 100)
  const fraction = String(Math.abs(value % 100))
    .padStart(2, '0')
    .replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''}%`
}
