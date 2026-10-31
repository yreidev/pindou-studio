import { Picker, Text, View } from '@tarojs/components'
import { Button } from '../../../components/button'
import Taro, { useRouter } from '@tarojs/taro'
import { ActionButton, Field, StaffScreen, Stepper } from '../../../components/staff'
import { Status } from '../../../components/customer'
import { DoneMark } from '../../../components/done-mark'
import {
  staffApi,
  StaffError,
  catalogLabel,
  type CatalogItem,
  type Order,
  type VenueSession,
} from '../../../services/staff'
import {
  blankLine,
  cashTender,
  decimalHundredths,
  discountZeroesOrder,
  draftLineErrors,
  hasUnsavedLines,
  orderLines,
  balanceCapCents,
  paymentAmount,
  validatedLines,
  zeroReceivableMessage,
  type DraftLine,
} from '../../../services/staff-workflow'
import { basisPoints, clockTime, money } from '../../../services/format'
import { compBlocker, compConfirmContent, compReasonError, paymentLine, timingNote } from '../../../services/charge'
import { nativeColors } from '../../../theme'
import { loyalty, type Quote } from '../../../services/membership'
import { MemberSettlement } from '../../../components/staff/member-settlement'
import { AccountSearch, accountText, type AccountChoice } from '../../../components/staff/account-search'
import { navigateApp, returnToPreviousPage } from '../../../services/navigation'
import { useLeaveGuard } from '../../../hooks/leave-guard'
import { useCustomer } from '../../../hooks/customer'
import { useCallback, useEffect, useRef, useState } from 'react'
import './index.scss'

/** 90 → 「90 分钟」，120 → 「2 小时」。 */
const hoursText = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`)

export default function Checkout() {
  const { params } = useRouter()
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [order, setOrder] = useState<Order | null>(null)
  const [lines, setLines] = useState<DraftLine[]>([])
  const [method, setMethod] = useState<'cash' | 'wechat' | 'alipay'>('wechat')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  // 收齐了：整屏的勾和金额（docs/plan-interaction.md 第 3 节）；点一下马上回上一页
  const [paidDone, setPaidDone] = useState<number | null>(null)
  const leaveDone = useRef<() => void>()
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [validate, setValidate] = useState(false)
  // 会员抵扣。以前这三样在另一个页面（会员与计时 › 结账 tab），现在就在这一屏。
  const [quote, setQuote] = useState<Quote | null>(null)
  const [points, setPoints] = useState('0')
  const [useBalance, setUseBalance] = useState(false)
  // 这次用多少储值（元）：会员只用储值付自己那份时填（多人合付）；空着就是能用多少用多少
  const [balanceText, setBalanceText] = useState('')
  // 人工折扣：柜台结账前当场减免（以前在订单管理页，订单管理搬去电脑后台后并到这里）。只有店长、老板能做。
  const auth = useCustomer()
  const canDiscount = !!auth.account?.roles.some((role) => role === 'manager' || role === 'owner')
  const [discountKind, setDiscountKind] = useState<'percentage' | 'fixed'>('percentage')
  const [discount, setDiscount] = useState('')
  const [discountReason, setDiscountReason] = useState('')
  // 会员扫码入座（会话带 admissionId）生成的套餐订单：按购买快照结算，后端拒绝改明细、打折和换顾客，
  // 这里读会话提前判断、不给入口（同网页结账页）。会话读不到时照常给，后端照样会拦。
  const [packageOrder, setPackageOrder] = useState(false)
  // 订单所属的会话：顶部写「已停止计时 14:40 · 2 小时」
  const [session, setSession] = useState<VenueSession | null>(null)
  // 顾客账户：绑定、更换或改散客。选好的人在提交成功前一直留着（版本冲突后重读、再确认还要用）
  const [customerEditing, setCustomerEditing] = useState(false)
  const [customerKeyword, setCustomerKeyword] = useState('')
  const [customerChoice, setCustomerChoice] = useState<AccountChoice | null>(null)
  // 现金时选填的实收现金（元）：切到微信、支付宝时不带
  const [cashText, setCashText] = useState('')
  // 这一笔收多少（元）：空着就是能收的全部（还差的数，会员单是报价的线下补付）；多人分着付时填这一笔的数。
  // 版本冲突重读时留着（和别的输入一样），收成了才清空
  const [amountText, setAmountText] = useState('')
  // 免单原因（店长、老板）：免单是一条单独的结清记录，不是把折扣打到 100%
  const [compReason, setCompReason] = useState('')
  const accept = (value: Order) => {
    setOrder(value)
    setLines(orderLines(value))
    setConflict(false)
    // 订单一变，上一份报价就作废了：它绑在旧的订单版本上，后端会拒。
    setQuote(null)
  }
  const load = useCallback(async () => {
    setError('')
    // 没带订单编号：不是「加载失败」，重新加载也不会长出编号来。页面里单独画一屏指回订单列表。
    if (!params.id) return
    try {
      const [value, items] = await Promise.all([staffApi.getOrder(params.id), staffApi.listCatalog()])
      // 先读会话再显示订单：套餐单不先闪出可改的明细
      const session = value.venueSessionId ? await staffApi.getSession(value.venueSessionId).catch(() => null) : null
      setCatalog(items)
      setPackageOrder(!!session?.admissionId)
      setSession(session)
      accept(value)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '订单加载失败')
    }
  }, [params.id])
  /**
   * 拿一份报价。会员单的收款必须带 quoteVersion，所以这一步躲不掉 ——
   * 但它不该让店员多点一次按钮：页面打开就按「不用积分、不用余额」先算一份，
   * 什么都不动也能直接收款。改了积分/余额/明细之后再重算。
   */
  const quoteFor = useCallback(async (target: Order, usePoints: string, balance: boolean, balanceCents?: number) => {
    const value = await loyalty.action<Quote>({
      action: 'quote',
      targetId: target.id,
      expectedVersion: target.version,
      points: Number(usePoints),
      useBalance: balance,
      // 只用一部分储值时才带；不带时请求和以前一样
      ...(balance && balanceCents !== undefined ? { balanceCents } : {}),
    })
    setQuote(value)
    return value
  }, [])
  // 会员结账只能是第一笔（草稿）：会员价按整单定。部分付款的单余下的照常收线下款
  const member = !!order?.accountId && order.status === 'draft'
  // 还没收齐的单都能收款：待结账，或部分付款（分笔付款收了一部分，计价与明细已冻结）
  const open = order?.status === 'draft' || order?.status === 'partially_paid'
  const partial = order?.status === 'partially_paid'
  const balanceCap = useBalance ? balanceCapCents(balanceText) : {}
  useEffect(() => {
    if (!member || !order || quote || busy) return
    if (!/^\d+$/.test(points)) return
    if (balanceCap.error) return
    void quoteFor(order, points, useBalance, balanceCap.cents).catch((failure) => {
      setError(failure instanceof Error ? failure.message : '会员优惠计算失败')
    })
  }, [member, order, quote, busy, points, useBalance, balanceCap.error, balanceCap.cents, quoteFor])
  useEffect(() => {
    void load()
  }, [load])
  const dirty = !!order && hasUnsavedLines(order, lines)
  useLeaveGuard(
    dirty ||
      !!discount ||
      !!discountReason.trim() ||
      !!compReason.trim() ||
      !!amountText.trim() ||
      (customerEditing && !!customerChoice),
    busy,
  )
  // 改过明细时只给一个参考合计（按整数分逐行相乘，不经浮点）：它不含折扣、会员价、积分和余额，
  // 真正要收多少以保存后服务端算的为准，所以这时按钮只「保存明细」，不带金额。
  const draftTotal = lines.reduce((sum, line) => {
    try {
      const count = Number(line.quantity)
      return Number.isSafeInteger(count) && count > 0 ? sum + decimalHundredths(line.unitPriceYuan, true) * count : sum
    } catch {
      return sum
    }
  }, 0)
  const receivable = order?.receivableCents ?? 0
  // 还差多少没收：接口给的 outstandingCents（草稿就是应收，部分付款是收齐还差的数）；重放的旧响应没有它时草稿按应收
  const outstanding = order ? (order.outstandingCents ?? (order.status === 'draft' ? receivable : 0)) : 0
  // 这次最多能收的：会员单收的是「线下补付」，不是原应收（余额和积分那部分不走收款方式）；其余是还差的数。金额都来自接口。
  const dueCents = dirty ? draftTotal : member && quote ? quote.offlineCents : outstanding
  const dueLabel = dirty
    ? '改动后合计（未保存，以保存后为准）'
    : member && quote
      ? '线下补付'
      : partial
        ? '还差'
        : '应收金额'
  // 这一笔收多少：空着就是 dueCents 全部，可以改小（多人分着付）；会员单可以填 0（这次只用储值，线下款余下的再收）
  const amountReady = open && !dirty && (!member || !!quote)
  const amount = amountReady ? paymentAmount(amountText, dueCents, member) : {}
  const thisCents = amount.cents ?? dueCents
  // 会员这一笔要收到钱：不用储值、这次又一分线下款都不收，分不出哪笔是会员的（后端拒绝），提前说
  const memberNothing =
    member &&
    quote &&
    amount.cents === 0 &&
    quote.principalCents === 0 &&
    quote.giftCents === 0 &&
    quote.offlineCents > 0
      ? '会员结账这一笔要收到钱：用储值，或这次至少收一部分线下款，余下的再收下一笔'
      : ''
  const placeholder = lines.some((line) => !Number(line.unitPriceYuan))
  // 现金才填实收；会员单由余额和积分付清（线下补付 0）或这次不收线下款时没有现金要收。应找零按这一笔算
  const cashing = method === 'cash' && !dirty && !(member && quote && (quote.offlineCents === 0 || amount.cents === 0))
  const cash = cashing ? cashTender(cashText, member && !quote ? null : (amount.cents ?? null)) : {}
  const blocked = !order
    ? '订单未加载'
    : dirty
      ? ''
      : receivable <= 0 && placeholder
        ? '有明细还没填单价，填好才能收款'
        : receivable <= 0
          ? '应收金额为 0，请检查明细'
          : member && !quote
            ? '正在计算会员优惠…'
            : amount.error || memberNothing || cash.error || ''
  const bound = !!order?.accountId
  const customerName = order?.accountId
    ? order.customer
      ? accountText({ id: order.accountId, nickname: order.customer.nickname, phoneMasked: order.customer.phoneMasked })
      : `顾客 ${order.accountId.slice(0, 8)}`
    : '散客'
  // 现在为什么不能换顾客（规则同网页结账页）；能换为空串
  const customerBlocked = !order
    ? '订单未加载'
    : order.status !== 'draft'
      ? '这张订单已经不是待结账状态'
      : packageOrder
        ? '这是会员扫码入座的套餐订单，顾客由入座申请决定，不能更换'
        : conflict
          ? '订单已被修改，请先重新读取订单并核对'
          : dirty
            ? '明细改过，请先保存明细再换顾客'
            : ''
  const run = async (task: () => Promise<void>) => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      await task()
    } catch (failure) {
      void Taro.hideToast()
      // 后端的说明原样显示（loyalty_conflict 也是：套餐单不能改明细、库存不足、体验已结束……各有各的原因）。
      // ★ 以前把所有 loyalty_conflict 都换成「会员资产或权益已变化」：套餐单保存明细被拒时店员看不出为什么。
      setError(failure instanceof Error ? failure.message : '操作失败，请重试')
      if (failure instanceof StaffError && ['order_version_conflict', 'idempotency_conflict'].includes(failure.code))
        setConflict(true)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  const updateLine = (index: number, field: keyof DraftLine, value: string) => {
    if (submitting.current || order?.status !== 'draft' || packageOrder) return
    setLines((previous) => previous.map((line, i) => (i === index ? { ...line, [field]: value } : line)))
  }
  /**
   * 结账分两步：明细改过时按钮只「保存明细」，保存后页面换成服务端算的应收（会员单是报价里的线下补付），
   * 按钮再变成「确认收款 ¥X」——按钮上的数就是要登记的数。
   *
   * ★ 曾经一次点击走完「保存 → 重新报价 → 收款」，按钮上写的却是前端按明细本地加出来的合计：
   *   不含折扣、会员价、积分和余额，有这些的单子店员看到的数和实际登记的线下款对不上，会多收或少收。
   *   多点一次换来金额一定对得上，值得。
   *
   * 保存后没收款时不回滚明细——那是已经落库的事实；页面据 `hasUnsavedLines` 就知道该保存还是该收款。
   */
  /** 明细改过就先保存，返回保存后的订单（折扣和收款都要在已保存的明细上算）。 */
  const saveLines = async (current: Order) => {
    if (!hasUnsavedLines(current, lines)) return current
    setValidate(true)
    const invalid = lines.findIndex((line) => Object.keys(draftLineErrors(line)).length > 0)
    if (invalid >= 0) {
      void Taro.pageScrollTo({ selector: `#checkout-line-${invalid}`, duration: 0 })
      throw new Error(`请检查第 ${invalid + 1} 项明细`)
    }
    const saved = await staffApi.updateOrder(current.id, validatedLines(lines), current.version)
    accept(saved)
    return saved
  }
  const applyDiscount = () =>
    run(async () => {
      if (!order || order.status !== 'draft') return
      if (conflict) throw new Error('请先重新读取订单')
      const value = decimalHundredths(discount)
      if (discountKind === 'percentage' && value > 10000) throw new Error('减免比例不能超过 100%')
      if (!discountReason.trim()) throw new Error('请填写折扣原因')
      // 减免 100% 不管明细是多少都会减到 0，先说；固定金额要和保存明细之后的应收比
      if (discountKind === 'percentage' && value >= 10000) throw new Error(zeroReceivableMessage)
      const current = await saveLines(order)
      if (discountZeroesOrder(discountKind, value, current.receivableCents)) throw new Error(zeroReceivableMessage)
      accept(
        await staffApi.discountOrder(
          current.id,
          {
            kind: discountKind,
            ...(discountKind === 'fixed' ? { amountCents: value } : { rateBasisPoints: value }),
            reason: discountReason.trim(),
          },
          current.version,
        ),
      )
      setDiscount('')
      setDiscountReason('')
      void Taro.showToast({ title: '折扣已应用', icon: 'success' })
    })
  /** 改过明细：先保存，页面换成服务端算的应收（会员单随后自动重算报价），店员看清金额再收款。 */
  const saveOnly = () =>
    run(async () => {
      if (!order || order.status !== 'draft') return
      if (conflict) throw new Error('请先重新读取订单')
      await saveLines(order)
      void Taro.showToast({ title: '明细已保存，请核对金额', icon: 'none' })
    })
  /**
   * 收一笔。一单可以分几笔收（多人合付）：这一笔不超过还差的数，收齐就结清、回上一页；没收齐订单是部分付款，
   * 留在这一页接着「收下一笔」（第一笔之后计价与明细冻结，不能再改）。会员单的第一笔走会员结账（会员价按整单定），
   * 线下补付可以只收一部分（offlineCents），余下的照常分笔收。
   */
  const settle = () =>
    run(async () => {
      if (!order || !open) return
      if (conflict) throw new Error('请先重新读取订单')
      // 金额以店员看到的那份为准：明细有未保存的改动就不收款（按钮此时只能「保存明细」）
      if (hasUnsavedLines(order, lines)) throw new Error('明细改过，请先保存并核对金额')
      const current = order
      if (current.receivableCents <= 0) throw new Error('应收金额为 0，请先填写明细单价')
      if (amount.error || memberNothing) throw new Error(amount.error || memberNothing)
      if (cash.error) throw new Error(cash.error)
      let after: Order | undefined
      if (current.accountId && current.status === 'draft') {
        // 会员单：用页面上展示的那份报价收款；后端发现它过期会拒（loyalty_conflict，见下）
        if (!quote) throw new Error('正在计算会员优惠，请稍候')
        const shown = quote
        let refused: StaffError | null = null
        try {
          const result = await loyalty.action<{ order?: Order } | undefined>({
            action: 'checkout',
            targetId: current.id,
            expectedVersion: current.version,
            quoteVersion: shown.version,
            points: Number(points),
            useBalance,
            // 和报价时一样的储值上限（报价版本按它算）
            ...(useBalance && balanceCap.cents !== undefined ? { balanceCents: balanceCap.cents } : {}),
            method,
            // 线下补付只收一部分（含 0）才带；空着就是全部、一次收齐，请求和以前一样
            ...(amountText.trim() && amount.cents !== undefined ? { offlineCents: amount.cents } : {}),
            ...(cash.receivedCents === undefined ? {} : { cashReceivedCents: cash.receivedCents }),
          })
          after = result?.order
        } catch (failure) {
          if (!(failure instanceof StaffError) || failure.code !== 'loyalty_conflict') throw failure
          refused = failure
        }
        if (refused) {
          // 会员结账被拒：先核对订单还是不是这一版（同网页结账页）。订单变了（别处改了明细、换了顾客、已收款），
          // 后端也回 loyalty_conflict：按冲突处理，保留输入、给「重新读取订单」，不拿旧版本去重算报价。
          // ★ 以前一律按旧版本重算报价，再被拒，页面停在「订单已变化，请重新读取」却没有重读的按钮。
          const fresh = await staffApi.getOrder(current.id).catch(() => null)
          const reason = refused.message.replace(/[。.]$/, '')
          if (fresh && fresh.version !== current.version) {
            setConflict(true)
            throw new Error(`${reason}。订单已在别处被修改，请重新读取订单，核对明细和金额后再确认收款`)
          }
          // 订单没变：会员资产或权益在报价之后变了（或库存不足等）。重算一份，金额变了让店员核对后再点，不自动重提
          const again = await quoteFor(current, points, useBalance, balanceCap.cents).catch(() => null)
          if (again && again.version !== shown.version)
            throw new Error(`${reason}。已重新计算优惠，金额有变化，请核对后再确认收款`)
          throw refused
        }
      } else {
        after = await staffApi.payOrder(current.id, method, thisCents, current.version, cash.receivedCents)
      }
      if (after?.status === 'partially_paid') {
        // 没收齐：留在这一页，显示已收几笔、还差多少，接着收下一笔（金额回到默认的还差全部）
        accept(after)
        setAmountText('')
        setCashText('')
        void Taro.showToast({
          title:
            after.outstandingCents === undefined
              ? `已收 ¥${money(after.paidCents)}`
              : `已收 ¥${money(after.paidCents)}，还差 ¥${money(after.outstandingCents)}`,
          icon: 'none',
        })
        return
      }
      if (after) accept(after)
      // 收齐了：整屏画出勾和金额，约 1 秒后自己回上一页，点一下马上回
      await new Promise<void>((resolve) => {
        leaveDone.current = resolve
        setPaidDone(after?.paidCents ?? current.receivableCents)
        setTimeout(resolve, 1000)
      })
      await returnToPreviousPage(true)
    })
  // 现在为什么不能免单；能免单为空串
  const compBlocked = order ? compBlocker({ order, dirty, conflict }) : '订单未加载'
  /**
   * 免单（店长、老板）：先确认（写清免掉多少、不能退款、不能改回），再带读到的订单版本提交；
   * 订单被改过或计时费随时间变了（409）保留原因，重读后由店员再确认。
   */
  const askComp = () => {
    if (!order) return
    const reasonError = compReasonError(compReason)
    if (compBlocked || reasonError) {
      setError(compBlocked || reasonError)
      return
    }
    const current = order
    const reason = compReason.trim()
    // 免掉的是还差的数（接口给的）；部分付款的单写清已收多少、剩下多少记免单
    const compCents = outstanding
    void Taro.showModal({
      title: partial ? `对剩余免单 ¥${money(compCents)}` : `免单 ¥${money(compCents)}`,
      content: compConfirmContent(compCents, reason, partial ? current.paidCents : 0),
      confirmText: '确认免单',
      confirmColor: nativeColors.danger,
    }).then((result) => {
      if (!result.confirm) return
      void run(async () => {
        accept(await staffApi.compOrder(current.id, reason, current.version))
        setCompReason('')
        void Taro.showToast({ title: '已免单', icon: 'success' })
        await returnToPreviousPage(true)
      })
    })
  }
  /** 绑定、更换顾客或改成散客（accountId 为 null）：带读到的订单版本；409 保留选好的人，重读后由店员再确认。 */
  const changeCustomer = (accountId: string | null) =>
    run(async () => {
      if (!order) return
      if (customerBlocked) throw new Error(customerBlocked)
      const before = order.accountId
      accept(await staffApi.setOrderCustomer(order.id, accountId, order.version))
      setCustomerEditing(false)
      setCustomerChoice(null)
      setCustomerKeyword('')
      // 新顾客从「不用积分、不用余额」重新报价（报价绑着订单版本，换人后旧报价作废）
      setPoints('0')
      setUseBalance(false)
      setBalanceText('')
      void Taro.showToast({
        title: !accountId ? '已改为散客' : before ? '已更换顾客' : '已绑定顾客',
        icon: 'success',
      })
    })
  const askClearCustomer = () => {
    void Taro.showModal({
      title: '改为散客',
      content: `订单将不再关联「${customerName}」，结账时不能用会员余额和积分，直接登记线下收款。`,
      confirmText: '改为散客',
    }).then((result) => {
      if (result.confirm) void changeCustomer(null)
    })
  }
  const statusText =
    order?.status === 'draft' ? '待结账' : partial ? '部分付款' : order?.settlement === 'comp' ? '已免单' : '历史订单'
  const timingText = session
    ? `${session.stoppedAt ? `已停止计时 ${clockTime(session.stoppedAt)}` : `${clockTime(session.startedAt)} 开始`}${
        session.durationMinutes ? ` · ${hoursText(session.durationMinutes)}` : ''
      } · `
    : ''
  // 待结账时顾客在下面单独一块；其余状态写在这一行
  const customerMeta =
    order && order.status !== 'draft'
      ? order.accountId
        ? ` · 会员${order.customer?.nickname ? ` ${order.customer.nickname}` : ''}`
        : ' · 散客'
      : ''
  const summaryMeta = order ? `${timingText}${statusText} · 订单 ${order.id.slice(0, 8)}${customerMeta}` : ''
  const topLabel = dueLabel === '线下补付' ? '这次线下要收' : dueLabel === '应收金额' ? '这次要收' : dueLabel
  // 汇总卡下面的几行：会员单列报价（原应收、会员优惠、积分、储值），部分付款列应收和已收
  const summaryRows: { label: string; value: string }[] =
    dirty || !order
      ? []
      : member && quote
        ? [
            { label: '原应收', value: `¥${money(quote.originalCents)}` },
            ...(quote.discountCents > 0 ? [{ label: '会员优惠', value: `−¥${money(quote.discountCents)}` }] : []),
            ...(quote.pointsCents > 0
              ? [{ label: `积分抵扣（${quote.pointsUsed} 分）`, value: `−¥${money(quote.pointsCents)}` }]
              : []),
            ...(quote.principalCents + quote.giftCents > 0
              ? [{ label: '储值抵扣（本金 + 赠送）', value: `−¥${money(quote.principalCents + quote.giftCents)}` }]
              : []),
          ]
        : partial
          ? [
              { label: '应收', value: `¥${money(receivable)}` },
              { label: '已收', value: `¥${money(order.paidCents)}` },
            ]
          : []
  return (
    <StaffScreen
      title="结账"
      loading={!!params.id && !order && !error}
      error={!order && error ? new Error(error) : undefined}
      onRetry={() => {
        void load()
      }}
    >
      {!params.id && (
        <Status
          kind="empty"
          title="缺少订单编号"
          message="请从订单列表选一笔订单进入结账。"
          action="返回订单列表"
          onAction={() => {
            void navigateApp('/pages/staff/orders/index', true)
          }}
        />
      )}
      {order && (
        <>
          {/* 顶部汇总：这次要收多少（会员单是线下补付），下面列原应收和抵扣。数都来自接口和报价 */}
          <View className="checkout-summary">
            <Text className="checkout-summary-meta">{summaryMeta}</Text>
            <Text className="checkout-summary-label">{topLabel}</Text>
            <Text className="checkout-summary-total">¥{money(dueCents)}</Text>
            {summaryRows.length > 0 && (
              <View className="checkout-summary-rows">
                {summaryRows.map((row) => (
                  <View className="checkout-summary-row" key={row.label}>
                    <Text>{row.label}</Text>
                    <Text>{row.value}</Text>
                  </View>
                ))}
              </View>
            )}
            {member && quote && !dirty && (
              <Text className="checkout-summary-note">本次消费获得 {quote.earnedPoints} 积分</Text>
            )}
          </View>
          {error && (
            <View className="inline-error" role="alert">
              {error}
            </View>
          )}
          {conflict && (
            <ActionButton
              loading={busy}
              disabled={busy}
              variant="outline"
              onClick={() => {
                void Taro.showModal({
                  title: '重新读取订单',
                  content: '当前未保存的修改将被替换。读取后请核对明细和金额。',
                  confirmText: '重新读取',
                }).then((result) => {
                  if (result.confirm) void run(load)
                })
              }}
            >
              重新读取订单
            </ActionButton>
          )}
          {order.status === 'draft' && (
            <View className="staff-section checkout-customer">
              <Text className="staff-section-title">顾客</Text>
              <View className="checkout-customer-card">
                <Text className={`checkout-customer-initial ${bound ? '' : 'checkout-customer-guest'}`}>
                  {bound ? (order.customer?.nickname || '会').slice(0, 1) : '散'}
                </Text>
                <View className="checkout-customer-copy">
                  <Text className="checkout-customer-name">{customerName}</Text>
                  <Text className="field-help">
                    {packageOrder
                      ? '会员扫码入座的套餐订单，顾客由入座申请决定，不能更换。'
                      : bound
                        ? '已绑定顾客账户，结账时可用余额和积分抵扣。'
                        : '散客单：没有绑定顾客账户，不能用会员余额和积分；要用，先绑定顾客账户。'}
                  </Text>
                </View>
              </View>
              {!packageOrder && customerEditing && (
                <>
                  <AccountSearch
                    label="搜索顾客"
                    keyword={customerKeyword}
                    onKeyword={setCustomerKeyword}
                    selected={customerChoice}
                    onSelect={setCustomerChoice}
                    disabled={busy}
                    scan
                  />
                  {bound && <Text className="field-help">换了顾客，会员优惠按新顾客重新计算。</Text>}
                  <ActionButton
                    loading={busy}
                    disabled={busy || !!customerBlocked || !customerChoice || customerChoice.id === order.accountId}
                    onClick={() => {
                      if (customerChoice) void changeCustomer(customerChoice.id)
                    }}
                  >
                    {bound ? '确认更换' : '确认绑定'}
                  </ActionButton>
                  <Button
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setCustomerEditing(false)
                      setCustomerChoice(null)
                      setCustomerKeyword('')
                    }}
                  >
                    取消
                  </Button>
                </>
              )}
              {!packageOrder && !customerEditing && (
                <View className="checkout-customer-actions">
                  <ActionButton
                    variant="outline"
                    disabled={busy || !!customerBlocked}
                    onClick={() => setCustomerEditing(true)}
                  >
                    {bound ? '更换顾客' : '绑定顾客账户'}
                  </ActionButton>
                  {bound && (
                    <Button
                      className="text-button text-danger"
                      disabled={busy || !!customerBlocked}
                      onClick={askClearCustomer}
                    >
                      改为散客
                    </Button>
                  )}
                </View>
              )}
              {!packageOrder && !!customerBlocked && <Text className="field-help">{customerBlocked}</Text>}
            </View>
          )}
          <View className="checkout-workspace">
            <View className="staff-section checkout-lines">
              <Text className="staff-section-title">明细</Text>
              {/* 计时费：后端按发布的规则算好的（超时加收、自由计时、陪客费），原样显示；员工改过计时行时提醒核对 */}
              {(() => {
                const note = timingNote(order.timing)
                if (!note) return null
                return (
                  <View className="checkout-timing">
                    <Text className={note.warning ? 'staff-notice' : 'strong'}>{note.title}</Text>
                    {note.lines.map((line) => (
                      <Text className="staff-list-meta" key={line}>
                        {line}
                      </Text>
                    ))}
                  </View>
                )
              })()}
              {packageOrder || partial ? (
                <>
                  <Text className="staff-notice">
                    {partial
                      ? '已收第一笔：计时停在收第一笔那一刻，计价与明细已冻结，不能再改明细、打折或换顾客；接着收下一笔，或由店长、老板对剩余免单。'
                      : '这是会员扫码入座的套餐订单：按购买时的套餐快照结算，明细和价格不能改，也不能人工折扣；其他消费请另建订单。'}
                  </Text>
                  {(order.lines || []).map((line, index) => (
                    <View className="checkout-line" key={index}>
                      <View className="checkout-line-copy">
                        <Text className="strong">{line.name || '消费项目'}</Text>
                        <Text className="staff-list-meta">
                          ¥{money(line.unitPriceCents)} × {line.quantity}
                        </Text>
                      </View>
                      <Text className="checkout-line-amount">¥{money(line.unitPriceCents * line.quantity)}</Text>
                    </View>
                  ))}
                </>
              ) : (
                <>
                  <Text className="staff-list-meta">
                    计时或服务费请选择自定义服务；商品收款时扣减库存，请先登记采购入库。
                  </Text>
                  {lines.map((line, index) => (
                    <View className="checkout-line-edit" id={`checkout-line-${index}`} key={index}>
                      <View className="checkout-line-fields">
                        <Text className="checkout-line-heading strong">明细 {index + 1}</Text>
                        <Picker
                          className="checkout-line-product"
                          disabled={busy || order.status !== 'draft'}
                          range={['自定义服务（不扣库存）', ...catalog.map((item) => `商品 · ${catalogLabel(item)}`)]}
                          value={catalog.findIndex((item) => item.id === line.productId) + 1}
                          onChange={(event) => {
                            if (submitting.current || order.status !== 'draft') return
                            const item = catalog[Number(event.detail.value) - 1]
                            setLines((previous) =>
                              previous.map((entry, i) =>
                                i === index
                                  ? {
                                      ...entry,
                                      productId: item?.id || '',
                                      name: item ? catalogLabel(item) : '',
                                      unitPriceYuan: item ? money(item.unitPriceCents) : '',
                                    }
                                  : entry,
                              ),
                            )
                          }}
                        >
                          <View className="staff-picker">
                            {line.productId
                              ? `商品 · ${catalog.find((item) => item.id === line.productId)?.name || line.name || '未命名商品'}`
                              : '自定义服务（不扣库存）'}
                          </View>
                        </Picker>
                        <Field
                          className="checkout-line-name"
                          error={validate ? draftLineErrors(line).name : ''}
                          label={`明细 ${index + 1} · 商品/服务名称`}
                          value={line.name}
                          onChange={(value) => updateLine(index, 'name', value)}
                          disabled={busy || order.status !== 'draft'}
                        />
                        <Stepper
                          error={validate ? draftLineErrors(line).quantity : ''}
                          label={`明细 ${index + 1} · 数量`}
                          value={line.quantity}
                          onChange={(value) => updateLine(index, 'quantity', value)}
                          disabled={busy || order.status !== 'draft'}
                        />
                        <Field
                          error={validate ? draftLineErrors(line).price : ''}
                          label={`明细 ${index + 1} · 单价（元）`}
                          value={line.unitPriceYuan}
                          onChange={(value) => updateLine(index, 'unitPriceYuan', value)}
                          type="digit"
                          disabled={busy || order.status !== 'draft'}
                        />
                        <Button
                          disabled={busy || order.status !== 'draft'}
                          ariaLabel={`移除第 ${index + 1} 项明细`}
                          className="text-button text-danger"
                          onClick={() => setLines((previous) => previous.filter((_, i) => i !== index))}
                        >
                          移除明细
                        </Button>
                      </View>
                    </View>
                  ))}
                  <Button
                    disabled={busy || order.status !== 'draft'}
                    className="checkout-add-line"
                    onClick={() => setLines((previous) => [...previous, blankLine()])}
                  >
                    添加明细
                  </Button>
                  <Text className={dirty ? 'staff-notice' : 'staff-list-meta'}>
                    {dirty ? '明细尚未保存' : order.status === 'draft' ? '明细已保存' : '订单已结算'}
                  </Text>
                </>
              )}
            </View>
            <View className="checkout-payment">
              {/* 分笔付款：已收的每一笔（方式、金额、时间，现金的实收找零，会员结账那几条标出来）和还差多少，都是接口的数 */}
              {!!order.payments?.length && (
                <View className="staff-section checkout-payments">
                  <Text className="staff-section-title">
                    {partial
                      ? `已收 ${order.payments.filter((payment) => payment.method !== 'comp').length} 笔 · ¥${money(order.paidCents)}`
                      : '付款记录'}
                  </Text>
                  {order.payments.map((payment) => {
                    const row = paymentLine(payment)
                    return (
                      <View className="checkout-line" key={payment.id}>
                        <View className="checkout-line-copy">
                          <Text className="strong">{row.title}</Text>
                          <Text className="staff-list-meta">{row.detail}</Text>
                        </View>
                        <Text className="checkout-line-amount">{row.amount}</Text>
                      </View>
                    )
                  })}
                  {partial && (
                    <View className="row row-between">
                      <Text className="strong">还差</Text>
                      <Text className="money">¥{money(outstanding)}</Text>
                    </View>
                  )}
                </View>
              )}
              {member && (
                <MemberSettlement
                  quote={quote}
                  points={points}
                  setPoints={(value) => {
                    setPoints(value)
                    setQuote(null)
                  }}
                  useBalance={useBalance}
                  setUseBalance={(value) => {
                    setUseBalance(value)
                    setQuote(null)
                  }}
                  balance={balanceText}
                  setBalance={(value) => {
                    setBalanceText(value)
                    setQuote(null)
                  }}
                  balanceError={balanceCap.error || ''}
                  disabled={busy || order.status !== 'draft'}
                />
              )}
              {canDiscount && open && <Text className="checkout-group-label">店长、老板才有</Text>}
              {canDiscount && order.status === 'draft' && !packageOrder && (
                <View className="staff-section checkout-manager">
                  <Text className="staff-section-title">人工折扣</Text>
                  <Text className="field-help">
                    固定金额或按比例减免，要写原因；折扣不能把应收减到 0，不收钱用免单。
                  </Text>
                  {(order.discounts || []).map((item, index) => (
                    <Text className="staff-list-meta" key={index}>
                      已减免 ·{' '}
                      {item.kind === 'fixed'
                        ? `¥${money(item.amountCents || 0)}`
                        : basisPoints(item.rateBasisPoints || 0)}{' '}
                      · {item.reason}
                    </Text>
                  ))}
                  <View className="checkout-choices">
                    {(['percentage', 'fixed'] as const).map((kind) => (
                      <Button
                        disabled={busy || conflict}
                        key={kind}
                        className={`checkout-choice ${discountKind === kind ? 'checkout-choice-on' : ''}`}
                        ariaLabel={`${kind === 'fixed' ? '固定金额' : '比例减免'}${discountKind === kind ? '，已选中' : ''}`}
                        onClick={() => {
                          setDiscountKind(kind)
                          setDiscount('')
                        }}
                      >
                        {kind === 'fixed' ? '固定金额' : '比例减免'}
                      </Button>
                    ))}
                  </View>
                  <Field
                    help={
                      discountKind === 'fixed'
                        ? '直接减免的金额，单位为元'
                        : '填写减免比例，例如 10 表示减免 10%，即付九折'
                    }
                    label={discountKind === 'fixed' ? '减免金额（元）' : '减免百分比'}
                    value={discount}
                    disabled={busy}
                    onChange={setDiscount}
                    type="digit"
                    placeholder="例如 10"
                  />
                  <Field
                    label="折扣原因"
                    value={discountReason}
                    disabled={busy}
                    onChange={setDiscountReason}
                    placeholder="必须填写原因"
                  />
                  <ActionButton
                    loading={busy}
                    disabled={busy || conflict || !discount || !discountReason.trim()}
                    variant="outline"
                    onClick={() => {
                      void applyDiscount()
                    }}
                  >
                    应用折扣
                  </ActionButton>
                </View>
              )}
              {canDiscount && open && (
                <View className="staff-section checkout-manager">
                  <Text className="staff-section-title">{partial ? '对剩余免单' : '免单'}</Text>
                  <Text className="field-help">
                    {partial
                      ? `已收 ¥${money(order.paidCents)}，还差 ¥${money(outstanding)}：剩下的不收了就对剩余免单（写明原因），免掉的部分不能退款，已收的照常可退。`
                      : '这一单不收钱、直接结清：应收照旧记账，记为免单，实收 0，不能退款。和人工折扣不同，折扣不能把应收减到 0。'}
                  </Text>
                  <Field
                    label="免单原因"
                    value={compReason}
                    disabled={busy}
                    onChange={setCompReason}
                    placeholder="必须填写原因"
                  />
                  <ActionButton
                    loading={busy}
                    disabled={busy || !!compBlocked || !compReason.trim()}
                    variant="danger"
                    onClick={askComp}
                  >
                    {partial ? '剩余免单' : '免单结清'}
                  </ActionButton>
                  {!!compBlocked && <Text className="field-help">{compBlocked}</Text>}
                </View>
              )}
              <View className="staff-section">
                <Text className="staff-section-title">{partial ? '收下一笔' : '线下收款'}</Text>
                <View className="checkout-choices checkout-choices-3">
                  {(['wechat', 'alipay', 'cash'] as const).map((value) => (
                    <Button
                      disabled={busy || !open}
                      key={value}
                      className={`checkout-choice ${method === value ? 'checkout-choice-on' : ''}`}
                      ariaLabel={`${value === 'cash' ? '现金' : value === 'wechat' ? '微信' : '支付宝'}${method === value ? '，已选中' : ''}`}
                      onClick={() => setMethod(value)}
                    >
                      {value === 'cash' ? '现金' : value === 'wechat' ? '微信' : '支付宝'}
                    </Button>
                  ))}
                </View>
                {/* 多人分着付：这一笔收多少，默认能收的全部（还差的数；会员单是报价的线下补付），可以改小 */}
                {amountReady && dueCents > 0 && (
                  <Field
                    label={member ? '这次收线下款（元，选填）' : '这一笔收多少（元，选填）'}
                    value={amountText}
                    onChange={setAmountText}
                    type="digit"
                    placeholder={`全部 ¥${money(dueCents)}`}
                    disabled={busy}
                    error={amount.error || memberNothing || ''}
                    help={
                      member
                        ? '不填就收全部线下补付、一次收齐；朋友分着付时可以先收一部分（可填 0），余下的再收下一笔。'
                        : '不填就收还差的全部；几个人分着付时填这一笔的数，余下的再收下一笔。'
                    }
                  />
                )}
                {cashing && open && (
                  <>
                    <Field
                      label="实收现金（元，选填）"
                      value={cashText}
                      onChange={setCashText}
                      type="digit"
                      placeholder="顾客给的现金"
                      disabled={busy}
                      error={cash.error || ''}
                      help="填了就按它算找零，和实收一起记在付款记录上；不填只登记收款金额。"
                    />
                    {cash.changeCents !== undefined && (
                      <View className="row row-between">
                        <Text>应找零</Text>
                        <Text className="money">¥{money(cash.changeCents)}</Text>
                      </View>
                    )}
                  </>
                )}
              </View>
              <View className="bottom-action">
                <View className="row row-between">
                  <Text>{dueLabel}</Text>
                  <Text className="money checkout-total">¥{money(dueCents)}</Text>
                </View>
                {open && (
                  <>
                    <Text className="checkout-bottom-hint">核实钱到账了再点，这里只登记收款</Text>
                    <ActionButton
                      loading={busy}
                      disabled={busy || conflict || blocked !== ''}
                      onClick={() => {
                        void (dirty ? saveOnly() : settle())
                      }}
                    >
                      {busy
                        ? '正在提交'
                        : dirty
                          ? '保存明细'
                          : `${partial ? '收下一笔' : '确认收款'} ¥${money(thisCents)}`}
                    </ActionButton>
                    {/* 少收了（这一笔少于能收的全部）：收完订单是部分付款，余下的再收下一笔 */}
                    {!dirty && amount.partial && (
                      <Text className="field-help">这一笔没收齐，收完订单是部分付款，余下的再收下一笔。</Text>
                    )}
                    {/* 按钮点不动时要说清为什么，不能只是灰着 */}
                    {blocked !== '' && <Text className="field-help">{blocked}</Text>}
                  </>
                )}
              </View>
            </View>
          </View>
        </>
      )}
      {paidDone !== null && (
        <View className="done-overlay" role="alert" onClick={() => leaveDone.current?.()}>
          <DoneMark />
          <Text className="done-overlay-title">收款成功</Text>
          <Text className="done-overlay-amount">¥{money(paidDone)}</Text>
          <Text className="done-overlay-note">点一下返回</Text>
        </View>
      )}
    </StaffScreen>
  )
}
