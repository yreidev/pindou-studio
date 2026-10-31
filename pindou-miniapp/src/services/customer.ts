import type { components } from '../api/schema'

// 接口数据类型取自 docs/api.yaml 生成的 api/schema.d.ts；故意比契约宽松的才手写，
// 由 api/contract-check.ts 核对契约的响应仍然接得住。
type Schemas = components['schemas']
export type Role = Schemas['Account']['roles'][number]
export type DeveloperMode = Schemas['DeveloperMode']
export type Account = Schemas['Account']
/** 服务端顺带给的账户称呼，只供展示，不是权限依据。 */
export type AccountLabel = NonNullable<Schemas['AccountLabel']>
export type Order = {
  id: string
  version: string
  accountId?: string
  /**
   * 关联顾客的称呼，散客单为 null。幂等重放 0.0.7 之前记下的响应时没有这个字段，
   * 一律按「没有」处理，不要据此判断是不是会员单（那要看 accountId）。
   */
  customer?: AccountLabel | null
  venueSessionId?: string
  // 后端一直在返回，之前这里漏了：没有时间的订单卡，三张「测试1 ¥20.00」分不出先后。
  createdAt?: string
  /** partially_paid 是部分付款：分笔付款（多人合付）收了第一笔、还没收齐，计价与明细已冻结。 */
  status: 'draft' | 'partially_paid' | 'paid' | 'refunded' | 'voided'
  receivableCents: number
  /** 实收：各笔收到的钱之和，不含免单。 */
  paidCents: number
  /**
   * 还差多少没收（应收 − 已收 − 免单），后端算好的：草稿就是应收，部分付款是收齐还差的数，其余 0。
   * 幂等重放 0.0.21 及更早记下的响应时没有。
   */
  outstandingCents?: number
  lines?: Schemas['OrderLine'][]
  discounts?: Schemas['OrderDiscount'][]
  payments?: Schemas['Payment'][]
  refunds?: Schemas['Refund'][]
  /** comp 是免单结清（payments 里有一条 method 为 comp 的结清记录，没有收到钱）。其余见契约。 */
  settlement?: Schemas['Order']['settlement']
  /** 免单免掉的金额，只有免单结清的订单才有。 */
  compCents?: number
  /** 计时会话草稿上系统此刻按计时算的计时费与说明（超时加收、自由计时、陪客费），结账页原样显示。 */
  timing?: Schemas['OrderTiming']
}
export type Credential = { accessToken: string; expiresAt: string; accountId: string }
type WechatSession = Schemas['WechatSession']
export type AuthState = {
  status: 'loading' | 'anonymous' | 'authenticated' | 'error'
  account: Account | null
  error: string
  revision: number
}
export type CustomerPort = {
  request: (
    path: string,
    options: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; data?: unknown; accessToken?: string },
  ) => Promise<{ statusCode: number; data: unknown }>
  login: () => Promise<string>
  readCredential: () => unknown
  saveCredential: (credential: Credential) => void
  clearCredential: () => void
  readManualLoginRequired: () => boolean
  setManualLoginRequired: (required: boolean) => void
  onSessionCreated?: () => void
  now: () => number
}

export class CustomerError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 0) {
    super(message)
    this.name = 'CustomerError'
    this.code = code
    this.status = status
  }
}

// 登录、注册、认领时的几句不写「微信」（2026-10-28 提审被驳回，见 pages/register/index.tsx）
const messages: Record<string, string> = {
  not_registered: '你还没有注册，请先创建账号',
  unauthorized: '登录已过期，请重新登录',
  forbidden: '当前账号无权查看此内容',
  not_found: '内容不存在或已不可访问',
  already_registered: '你已经注册过了，请直接登录',
  already_claimed: '这个会员已经被认领了，不是你本人操作的话请联系店员',
  claim_required: '门店已经用这个手机号为你开过会员，请找店员要临时密码认领',
  privacy_required: '请先阅读并同意隐私协议，再设置新密码',
  invalid_request: '提交的信息不完整，请检查后重试',
  wechat_unavailable: '授权没有成功，请重新授权后重试',
  invalid_avatar: '头像图片无法保存，请重新选择较小的图片',
  // 页面在这句后面接门店联系方式（预约设置里的电话、微信号）
  reservation_limit_reached: '每个账号最多同时预约 2 个座位，更多座位请联系门店',
  store_closed: '门店这天歇业，请换一天预约',
  // 页面在这句后面接门店联系方式
  reservation_suspended: '最近爽约次数较多，暂时不能自助预约，请联系门店',
  // seat_in_use（座位现场正在使用）不登记：服务端的说明里带着「到 HH:MM 才空出」，原样显示
  network: '网络连接失败，请稍后重试',
  rate_limited: '操作太频繁，请稍后再试',
  no_active_session: '你现在没有进行中的计时，不能呼叫店员',
  service_call_cooldown: '店员刚处理过你的呼叫，请稍后再叫',
  // 认领店员代开的会员（手机号 + 店员发的临时密码）
  invalid_credentials: '手机号或密码不对',
  temporary_password_expired: '临时密码已过期，请到店里找店员重新领取',
  // 改资料换号：新号已被别的账户用来认领
  phone_registered: '这个手机号已被别的账户用过，不能换成它。有疑问请到店里找店员核对',
}

/**
 * 按错误码给顾客的说法：只用这里白名单里的话，不认识的按状态码给通用说法。
 * 不把服务端原文给顾客看——它可能带表名、约束名这类内部细节，顾客看了既没用也不安全（员工页才显示服务端原文）。
 */
export function messageForCode(code: string, status: number): string {
  return messages[code] || (status >= 500 ? '服务暂时不可用，请稍后重试' : '请求未完成，请稍后重试')
}
const cancelled = () => new CustomerError('cancelled', '请求已取消')
export const isCancelled = (error: unknown) => error instanceof CustomerError && error.code === 'cancelled'
export const errorMessage = (error: unknown) =>
  error instanceof CustomerError ? error.message : '网络连接失败，请稍后重试'

/**
 * 顾客页上显示的错误说明。走员工通道（services/staff.ts）的顾客请求，错误里带的是服务端 message；
 * 这里登记过的错误码一律换成本地文案，顾客看到的说法由小程序决定，不照搬服务端。
 */
export function customerMessage(error: unknown, fallback = '网络连接失败，请稍后重试'): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && messages[code]) return messages[code]
  return error instanceof Error && error.message ? error.message : fallback
}

function accountFrom(value: Account): Account {
  if (
    !value ||
    typeof value.id !== 'string' ||
    typeof value.nickname !== 'string' ||
    !['verified', 'unverified'].includes(value.phoneVerificationStatus)
  ) {
    throw new CustomerError('invalid_response', '账户数据暂时不可用，请稍后重试')
  }
  if (
    value.developerMode !== undefined &&
    !['developer', 'guest', 'customer', 'clerk', 'manager', 'owner'].includes(value.developerMode)
  )
    throw new CustomerError('invalid_response', '账户身份无效，请重新登录')
  return {
    ...value,
    roles: Array.isArray(value.roles) ? value.roles.filter((role) => ['clerk', 'manager', 'owner'].includes(role)) : [],
  }
}

export function phoneIsValid(value: string): boolean {
  return /^\+?\d{7,15}$/.test(value.trim())
}

/** 认领、代开会员用的手机号写法：去掉空格和横线（与后端 NormalizePhone 一致）。 */
export const loginPhone = (value: string) => value.replace(/[\s-]/g, '')
export const loginPhoneIsValid = (value: string) => /^\+?\d{6,15}$/.test(loginPhone(value))

export class CustomerClient {
  private port: CustomerPort
  private credential: Credential | null = null
  private epoch = 0
  private listeners = new Set<() => void>()
  private bootstrapTask: Promise<void> | null = null
  private switchingMode = false
  private state: AuthState = { status: 'loading', account: null, error: '', revision: 0 }

  constructor(port: CustomerPort) {
    this.port = port
  }
  getSnapshot = (): AuthState => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(status: AuthState['status'], account: Account | null = null, error = '') {
    this.state = {
      status: status === 'authenticated' && account?.developerMode === 'guest' ? 'anonymous' : status,
      account,
      error,
      revision: this.epoch,
    }
    this.listeners.forEach((listener) => listener())
  }
  private clear() {
    this.credential = null
    this.port.clearCredential()
  }
  private checkEpoch(epoch: number) {
    if (epoch !== this.epoch) throw cancelled()
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    data?: unknown,
    authorized = true,
  ): Promise<T> {
    const epoch = this.epoch
    if (authorized && (!this.credential || Date.parse(this.credential.expiresAt) <= this.port.now())) {
      this.signOut()
      throw new CustomerError('unauthorized', messages.unauthorized, 401)
    }
    let response: { statusCode: number; data: unknown }
    try {
      response = await this.port.request(path, {
        method,
        data,
        accessToken: authorized ? this.credential?.accessToken : undefined,
      })
    } catch {
      this.checkEpoch(epoch)
      throw new CustomerError('network', '网络连接失败，请稍后重试')
    }
    this.checkEpoch(epoch)
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const payload = response.data as { code?: string } | null
      const code = payload?.code || `http_${response.statusCode}`
      if (authorized && response.statusCode === 401) this.signOut()
      throw new CustomerError(code, messageForCode(code, response.statusCode), response.statusCode)
    }
    return response.data as T
  }

  private acceptSession(session: WechatSession, epoch: number, notify = true) {
    this.checkEpoch(epoch)
    const account = accountFrom(session.user)
    if (
      !session.accessToken ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= this.port.now()
    ) {
      throw new CustomerError('invalid_response', '登录结果无效，请重新登录')
    }
    this.credential = { accessToken: session.accessToken, expiresAt: session.expiresAt, accountId: account.id }
    this.port.saveCredential(this.credential)
    this.port.setManualLoginRequired(false)
    this.publish('authenticated', account)
    if (notify) this.port.onSessionCreated?.()
  }

  bootstrap = (): Promise<void> => {
    if (this.bootstrapTask) return this.bootstrapTask
    this.bootstrapTask = this.restore().finally(() => {
      this.bootstrapTask = null
    })
    return this.bootstrapTask
  }
  private async restore() {
    const epoch = ++this.epoch
    this.publish('loading')
    try {
      if (this.port.readManualLoginRequired()) {
        this.clear()
        this.publish('anonymous')
        return
      }
      const stored = this.port.readCredential() as Partial<Credential> | null
      if (
        stored &&
        typeof stored.accessToken === 'string' &&
        typeof stored.accountId === 'string' &&
        typeof stored.expiresAt === 'string' &&
        Date.parse(stored.expiresAt) > this.port.now()
      ) {
        this.credential = stored as Credential
        const account = accountFrom(await this.request<Account>(`/accounts/${encodeURIComponent(stored.accountId)}`))
        this.checkEpoch(epoch)
        if (account.id !== stored.accountId) throw new CustomerError('invalid_response', '账户数据不一致，请重新登录')
        this.publish('authenticated', account)
      } else {
        this.clear()
        this.publish('anonymous')
      }
    } catch (error) {
      if (isCancelled(error) || epoch !== this.epoch) return
      if (error instanceof CustomerError && error.status === 404) this.clear()
      this.publish('error', null, errorMessage(error))
    }
  }

  signIn = async () => {
    const epoch = ++this.epoch
    this.clear()
    this.publish('loading')
    try {
      const code = await this.port.login()
      this.checkEpoch(epoch)
      if (!code) throw new CustomerError('wechat_unavailable', messages.wechat_unavailable)
      this.acceptSession(
        await this.request<WechatSession>('/auth/wechat-sessions', 'POST', { wechatLoginCode: code }, false),
        epoch,
      )
    } catch (error) {
      if (isCancelled(error) || epoch !== this.epoch) return
      if (error instanceof CustomerError && error.code === 'not_registered') this.publish('anonymous')
      else this.publish('error', null, errorMessage(error))
    }
  }

  register = async (input: Omit<Schemas['AccountRegistrationInput'], 'wechatLoginCode'>) => {
    const nickname = input.nickname.trim()
    if (
      !nickname ||
      Array.from(nickname).length > 50 ||
      !input.privacyContractVersion ||
      Boolean(input.phone) === Boolean(input.phoneCode) ||
      (input.phone && !phoneIsValid(input.phone))
    ) {
      throw new CustomerError('invalid_request', '请确认昵称、手机号和隐私协议')
    }
    const epoch = ++this.epoch
    const code = await this.port.login()
    this.checkEpoch(epoch)
    if (!code) throw new CustomerError('wechat_unavailable', messages.wechat_unavailable)
    const session = await this.request<WechatSession>(
      '/accounts',
      'POST',
      { ...input, nickname, wechatLoginCode: code },
      false,
    )
    this.acceptSession(session, epoch)
  }

  /** 用已有会员的密码核对身份，再绑定本次微信。 */
  claimMember = async (input: Omit<Schemas['MemberClaimInput'], 'wechatLoginCode'>, notify = true) => {
    const phone = loginPhone(input.phone)
    if (!loginPhoneIsValid(phone) || !input.password || !input.privacyContractVersion)
      throw new CustomerError('invalid_request', '请确认手机号、密码和隐私协议')
    const epoch = ++this.epoch
    const code = await this.port.login()
    this.checkEpoch(epoch)
    if (!code) throw new CustomerError('wechat_unavailable', messages.wechat_unavailable)
    const session = await this.request<WechatSession>(
      '/auth/member-claims',
      'POST',
      { ...input, phone, wechatLoginCode: code },
      false,
    )
    this.acceptSession(session, epoch, notify)
  }

  cancelAuthentication = () => {
    if (this.credential) return
    ++this.epoch
    this.clear()
    this.publish('anonymous')
  }

  signOut = () => {
    ++this.epoch
    this.port.setManualLoginRequired(true)
    this.clear()
    this.publish('anonymous')
  }

  /** 用户主动退出：本地立即退出，同时让服务端作废这张令牌（不等结果；网络失败也不影响退出，令牌到期自然失效）。 */
  logOut = () => {
    const accessToken = this.credential?.accessToken
    this.signOut()
    if (accessToken)
      void this.port.request('/auth/sessions/current', { method: 'DELETE', accessToken }).catch(() => undefined)
  }

  switchDeveloperMode = async (mode: DeveloperMode) => {
    if (!this.state.account?.developerMode) throw new CustomerError('forbidden', messages.forbidden, 403)
    if (this.switchingMode) throw new CustomerError('busy', '正在切换身份，请稍候')
    this.switchingMode = true
    const accountId = this.credential?.accountId
    const epoch = ++this.epoch
    try {
      const session = await this.request<WechatSession>('/auth/developer-sessions', 'POST', { mode })
      if (session.user.id !== accountId || session.user.developerMode !== mode)
        throw new CustomerError('invalid_response', '身份切换结果不一致，请重新登录')
      this.acceptSession(session, epoch, false)
    } finally {
      this.switchingMode = false
    }
  }

  refreshAccount = async () => {
    const id = this.credential?.accountId
    if (!id) throw new CustomerError('unauthorized', messages.unauthorized, 401)
    const account = accountFrom(await this.request<Account>(`/accounts/${encodeURIComponent(id)}`))
    if (account.id !== id) throw new CustomerError('invalid_response', '账户数据不一致，请重新登录')
    this.publish('authenticated', account)
    return account
  }

  updateProfile = async (input: {
    nickname: string
    phone?: string
    // 微信 getPhoneNumber 换来的 code：后端换出号码并标为已验证。与 phone 互斥（后端也会拒）。
    phoneCode?: string
    avatarDataUrl?: string
  }) => {
    const id = this.credential?.accountId
    if (!id) throw new CustomerError('unauthorized', messages.unauthorized, 401)
    const nickname = input.nickname.trim()
    if (!nickname || Array.from(nickname).length > 50 || (input.phone !== undefined && !phoneIsValid(input.phone)))
      throw new CustomerError('invalid_request', '请填写有效的昵称和手机号')
    if (input.phone && input.phoneCode)
      throw new CustomerError('invalid_request', '快捷填写和手动填写的手机号只能二选一')
    const account = accountFrom(
      await this.request<Account>(`/accounts/${encodeURIComponent(id)}`, 'PATCH', {
        nickname,
        ...(input.phone ? { phone: input.phone.trim() } : {}),
        ...(input.phoneCode ? { phoneCode: input.phoneCode } : {}),
        ...(input.avatarDataUrl !== undefined ? { avatarDataUrl: input.avatarDataUrl } : {}),
      }),
    )
    if (account.id !== id) throw new CustomerError('invalid_response', '账户数据不一致，请重新登录')
    this.publish('authenticated', account)
    return account
  }

  private checkedOrder(order: Order): Order {
    if (!order || order.accountId !== this.credential?.accountId)
      throw new CustomerError('forbidden', messages.forbidden, 403)
    const amounts = [
      order.receivableCents,
      order.paidCents,
      ...(order.lines || []).map((line) => line.unitPriceCents),
      ...(order.payments || []).map((payment) => payment.amountCents),
      ...(order.refunds || []).map((refund) => refund.amountCents),
    ]
    if (
      typeof order.id !== 'string' ||
      !['draft', 'partially_paid', 'paid', 'refunded', 'voided'].includes(order.status) ||
      amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)
    )
      throw new CustomerError('invalid_response', '订单数据暂时不可用，请稍后重试')
    return order
  }
  listOrders = async (): Promise<Order[]> => {
    const id = this.credential?.accountId
    if (!id) throw new CustomerError('unauthorized', messages.unauthorized, 401)
    const orders = await this.request<Order[]>(`/accounts/${encodeURIComponent(id)}/sales-orders`)
    if (!Array.isArray(orders)) throw new CustomerError('invalid_response', '订单数据暂时不可用，请稍后重试')
    return orders.map((order) => this.checkedOrder(order))
  }
  getOrder = async (id: string): Promise<Order> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new CustomerError('not_found', messages.not_found, 404)
    return this.checkedOrder(await this.request<Order>(`/sales-orders/${encodeURIComponent(id)}`))
  }
}
