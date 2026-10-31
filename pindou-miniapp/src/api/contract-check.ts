// 手写的接口数据类型与契约（docs/api.yaml → schema.d.ts）的编译期核对，由 npm run check 的 tsc 检查。
// 只有类型，没有任何页面或服务引用它，所以不进构建产物。
//
// 与契约完全一致的类型直接取自 schema.d.ts（见 services 各文件），不在这里。这里只核对故意比契约宽松
// 或只取部分字段的手写类型，每条两项：
// - Covers：服务端按契约返回的任何内容，小程序的类型都接得住（契约改了字段类型、加了枚举值、
//   把小程序当成必有的字段改成可选都会失败）；
// - NoDrift：小程序类型里逐层写到的字段契约里都有、写死的枚举值契约里都还在（契约删了、改了名、
//   删了枚举值会失败，失败信息里是字段路径，如 "Order.lines[].name"）。
// 失败时先按后端核对契约：契约错了改契约并重新生成（npm run api:types），小程序错了改小程序的类型。
import type { components, operations } from './schema'
import type { Order } from '../services/customer'
import type { ServiceTable, VenueSession } from '../services/staff'
import type { Admission, Entry, Member, Quote, Shift, Table } from '../services/membership'
import type { ReservationView } from '../services/reservations'

type Schemas = components['schemas']

/** Contract 能赋给 Mine，否则在这里报出哪个字段接不住。 */
type Covers<Mine, Contract extends Mine> = Contract
/** Paths 是 Drift 算出的多余字段路径，必须为空。 */
type NoDrift<Paths extends never> = Paths

type Item<T> = T extends readonly (infer I)[] ? I : never
type Keys<T> = T extends object ? keyof T : never
type Field<T, K extends PropertyKey> = T extends object ? (K extends keyof T ? T[K] : never) : never
/** Mine 里有、Contract 里没有的字段（逐层，数组看元素）和枚举值，给出路径；都有时为 never。 */
type Drift<Mine, Contract, Path extends string> = 0 extends 1 & Mine
  ? never // any 不往下查
  : [NonNullable<Mine>] extends [readonly unknown[]]
    ? Drift<Item<NonNullable<Mine>>, Item<NonNullable<Contract>>, `${Path}[]`>
    : [NonNullable<Mine>] extends [object]
      ? FieldDrift<NonNullable<Mine>, NonNullable<Contract>, Path>
      : ValueDrift<NonNullable<Mine>, NonNullable<Contract>, Path>
type FieldDrift<Mine, Contract, Path extends string> = {
  [K in keyof Mine & string]-?: K extends Keys<Contract>
    ? Drift<Mine[K], Field<Contract, K>, `${Path}.${K}`>
    : `${Path}.${K}`
}[keyof Mine & string]
/** 写成 string、number、boolean 的不查枚举；写死了取值的，每个值契约里都要有。 */
type ValueDrift<Mine, Contract, Path extends string> = string extends Mine
  ? never
  : number extends Mine
    ? never
    : boolean extends Mine
      ? never
      : [Exclude<Mine, Contract>] extends [never]
        ? never
        : `${Path} = ${Extract<Exclude<Mine, Contract>, string | number | boolean>}`

// ★ 已知的不一致，修好一处删一处豁免：
// - LoyaltyEntry.points：契约写可为 null，但会员视图里后端一律给数组（History 把空的补成 []），
//   页面直接 .map。核对时按数组算；契约该改成非空数组。
type MemberViewEntry = Omit<Schemas['LoyaltyEntry'], 'points'> & {
  points: NonNullable<Schemas['LoyaltyEntry']['points']>
}
type MemberView = Omit<Schemas['LoyaltyMember'], 'entries'> & { entries: MemberViewEntry[] }
type ShiftResponse = operations['getLoyaltyShift']['responses'][200]['content']['application/json']

/** Order（customer.ts）：customer、createdAt 可选，不取退款汇总、memberCheckout、autoLines。 */
export type OrderCheck = [Covers<Order, Schemas['Order']>, NoDrift<Drift<Order, Schemas['Order'], 'Order'>>]

/** ServiceTable（staff.ts）：code、zone、wholeTable、seatBased、timingMode 可选。charge 照契约。 */
export type ServiceTableCheck = [
  Covers<ServiceTable, Schemas['ServiceTable']>,
  NoDrift<Drift<ServiceTable, Schemas['ServiceTable'], 'ServiceTable'>>,
]

/** VenueSession（staff.ts）对 ServiceTableSession：不取 pausedAt、pausedSeconds。 */
export type VenueSessionCheck = [
  Covers<VenueSession, Schemas['ServiceTableSession']>,
  NoDrift<Drift<VenueSession, Schemas['ServiceTableSession'], 'VenueSession'>>,
]

/** Entry（membership.ts）对 LoyaltyEntry：kind 按字符串收（新流水类型原样显示），不取 method；points 见上。 */
export type EntryCheck = [Covers<Entry, MemberViewEntry>, NoDrift<Drift<Entry, Schemas['LoyaltyEntry'], 'Entry'>>]

/** Admission（membership.ts）对 LoyaltyAdmissionView：customer 可选，申请与会话只取用到的字段，status 按字符串收。 */
export type AdmissionCheck = [
  Covers<Admission, Schemas['LoyaltyAdmissionView']>,
  NoDrift<Drift<Admission, Schemas['LoyaltyAdmissionView'], 'Admission'>>,
]

/** Member（membership.ts）对 LoyaltyMember：entries 见上。 */
export type MemberCheck = [Covers<Member, MemberView>, NoDrift<Drift<Member, Schemas['LoyaltyMember'], 'Member'>>]

/** Table（membership.ts）对 LoyaltyTable：code、zone、wholeTable 可选。 */
export type TableCheck = [
  Covers<Table, Schemas['LoyaltyTable']>,
  NoDrift<Drift<Table, Schemas['LoyaltyTable'], 'Table'>>,
]

/** Shift（membership.ts）对 /loyalty/shift 的响应：入座申请与桌位用上面的 Admission、Table。 */
export type ShiftCheck = [Covers<Shift, ShiftResponse>, NoDrift<Drift<Shift, ShiftResponse, 'Shift'>>]

/** Quote（membership.ts）对 LoyaltyQuote：不取 pointsValidDays、birthdayEntryId。 */
export type QuoteCheck = [
  Covers<Quote, Schemas['LoyaltyQuote']>,
  NoDrift<Drift<Quote, Schemas['LoyaltyQuote'], 'Quote'>>,
]

/** ReservationView（reservations.ts）：桌位用上面的 Table，其余与契约相同。 */
export type ReservationViewCheck = [
  Covers<ReservationView, Schemas['ReservationView']>,
  NoDrift<Drift<ReservationView, Schemas['ReservationView'], 'ReservationView'>>,
]
