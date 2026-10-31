import Taro from '@tarojs/taro'
import type { components, operations } from '../api/schema'
import { CustomerError, type AccountLabel, type Order } from './customer'
import { apiBase } from './api-base'
import { queryString, request, requestPage, searchKeyword } from './staff'

type Schemas = components['schemas']
type PublicLoyalty = operations['getPublicLoyalty']['responses'][200]['content']['application/json']
export type Rule = Schemas['LoyaltyRule']
export type Balance = Schemas['LoyaltyBalance']
// Entry、Admission、Member、Table、Shift、Quote 比契约宽松或只取部分字段，手写，由 api/contract-check.ts 核对。
export type Entry = {
  id: string
  accountId: string
  kind: string
  sourceId: string
  reason: string
  principalCents: number
  giftCents: number
  /** 契约允许 null，但会员视图里后端一律给数组（没有积分变动就是空数组），页面直接遍历。 */
  points: Schemas['LoyaltyPointChange'][]
  rule?: Rule
  serviceDate?: string
  boardUses?: number
  consumption?: Schemas['LoyaltyConsumption']
  balanceAfter?: Schemas['LoyaltyBalanceAfter']
  createdAt: string
}
export type Admission = {
  /**
   * 这条申请**此刻**的状态，后端按当前时间算出来的。
   *
   * ★ 一律看这个，不要看 `admission.status`。Status 只有被人点过才会变
   *   （确认/拒绝/取消），而过期是时间到了自然发生的、没人点 —— 所以过期的申请
   *   `status` 会一直停在 'pending'。2026-09-20 顾客端因此一直写着「等待员工确认」，
   *   员工端一直摆着「确认开台」，点下去才报过期。
   */
  displayStatus: 'pending' | 'confirmed' | 'rejected' | 'cancelled' | 'expired'
  admission: {
    id: string
    accountId: string
    serviceTableId: string
    seatNumber: number
    package: Rule
    status: string
    venueSessionId?: string
    /** 顾客申请的时间。 */
    createdAt?: string
    /** 团购记录（顾客扫码入座时填、员工确认时可改）；没填时省略。 */
    coupon?: Schemas['Coupon']
  }
  /**
   * 按座会话才有座号；页面取不到时退回申请里的座号。untilClose：用的是「到打烊」的套餐，结束时间固定在打烊，
   * 不能暂停、续时。status 为 ended 是系统内收费关着时员工点了「结束」放座。
   */
  session?: {
    id: string
    serviceTableId: string
    seatNumber?: number
    status: string
    startedAt: string
    /** 自由计时（free）没有约定时长，首页写「自由计时」 */
    timingMode?: 'timed' | 'free'
    stoppedAt?: string
    untilClose?: true
  }
  sessionVersion?: string
  elapsedSeconds?: number
  remainingSeconds?: number
  overdueSeconds?: number
  order?: Order
  /** 待确认的申请到这一刻没人确认就失效（后端按申请时刻加确认时限算好）：现场页写「再过 N 分钟失效」。别的状态没有。 */
  expiresAt?: string
  /** 申请人的称呼（员工视图才有），账户不在了为 null。 */
  customer?: AccountLabel | null
}
export type Member = {
  balance: Balance
  /** birthdayYear：顾客设置生日的那一年（门店时区，每个自然年只能设一次），没设过是 0 */
  profile: { birthday: string; birthdayYear: number }
  entries: Entry[]
  rules: Rule[]
  admissions: Admission[]
  version: string
}
export type Table = {
  id: string
  number: number
  /** 布局里的稳定编码（A1、B3…）。平面图按它对位，不再靠区域名加桌号猜。 */
  code?: string
  /** 分区字母，由 code 推出，顾客端画图分色用。 */
  zone?: string
  seatCount: number
  /**
   * 这张桌只能整张卖给一组客人（A 区双人位）。后端按它把整张桌一起锁住，
   * 顾客端的平面图据此确认「订一个位置 = 包下整桌」这件事在后端真的成立。
   */
  wholeTable?: boolean
  occupiedSeats: number[]
  floorAreaId: string
  /** 所属区域名称。桌号只在区域内唯一，跨区定位一张桌要靠区域加桌号 */
  floorAreaName: string
}
/** 员工会员列表里的一位：只带这一页的人的当前余额。 */
export type MemberSummary = Schemas['LoyaltyMemberSummary']
/** 员工这一班要看的：扫码入座申请（带顾客称呼）与桌位占用。 */
export type Shift = { admissions: Admission[]; tables: Table[] }
export type Quote = {
  originalCents: number
  discountCents: number
  pointsUsed: number
  pointsCents: number
  principalCents: number
  giftCents: number
  offlineCents: number
  earnedPoints: number
  version: string
}
export type LoyaltyAction = Schemas['LoyaltyAction']

/** 办给员工「会员与计时」页里选中那位会员的动作。 */
const memberActions = new Set<LoyaltyAction['action']>(['recharge', 'exchange', 'fulfill_gift', 'adjust', 'consume'])

/**
 * 「会员与计时」页的动作请求：只有会员动作（充值、兑换、礼物核销、手动加减）带上选中会员的编号和资产版本。
 * ★ 以前所有动作都合并：先在「会员」标签选了张三，再到「计时」标签确认李四的入座、给李四续时，
 *   请求里带着张三的 accountId，审计记成了「张三 loyalty.confirm / renew」。计时动作的对象是那次申请、
 *   那段计时，只带它们自己的 targetId 和计时版本。
 */
export function withChosenMember(input: LoyaltyAction, accountId: string, version?: string): LoyaltyAction {
  if (!memberActions.has(input.action)) return input
  return { expectedVersion: version, ...input, accountId: input.accountId || accountId || undefined }
}
async function read<T>(path: string): Promise<T> {
  try {
    return await request<T>(path)
  } catch (e) {
    const error = e as { code: string; message: string; status: number }
    throw new CustomerError(error.code, error.message, error.status)
  }
}
export const loyalty = {
  me: () => read<Member>('/loyalty/me'),
  tables: () => read<Table[]>('/loyalty/tables'),
  shift: () => request<Shift>('/loyalty/shift'),
  /** 会员列表：服务端按关键字筛选、按昵称拼音排、分页。 */
  members: (keyword: string, page = 1, pageSize = 20) =>
    requestPage<MemberSummary>(`/loyalty/members?${queryString({ q: searchKeyword(keyword), page, pageSize })}`, page),
  account: (id: string) => request<Member>(`/loyalty/account?accountId=${encodeURIComponent(id)}`),
  openAccount: (input: Schemas['MemberAccountInput']) =>
    request<Schemas['MemberAccountOpened']>('/member-accounts', 'POST', input),
  action: <T = Member>(input: LoyaltyAction) => request<T>('/loyalty/actions', 'POST', input, true),
  public: async () => {
    const response = await Taro.request<PublicLoyalty>({
      url: `${apiBase.replace(/\/$/, '')}/loyalty/public`,
      timeout: 15000,
    })
    if (response.statusCode !== 200) throw new Error('活动暂时无法加载')
    return response.data.rules
  },
}
export const ruleNames: Record<string, string> = {
  tier: '会员等级',
  recharge: '充值方案',
  earn: '消费积分',
  redeem: '积分抵扣',
  exchange: '积分兑换',
  birthday: '生日福利',
  package: '计时套餐',
}
export const entryNames: Record<string, string> = {
  recharge: '充值入账',
  tier: '等级权益',
  adjust: '资产调整',
  recharge_refund: '充值退款',
  exchange: '积分兑换',
  birthday: '生日福利',
  fulfill_gift: '礼物核销',
  checkout: '消费扣款',
  earned: '消费积分',
  refund: '消费退款',
  birthday_used: '生日折扣使用',
  consume: '消费',
  consume_reverse: '撤销消费',
}
