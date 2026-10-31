import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'
import { label, nodes, settle } from './helpers/tree'
import { billingMock } from './helpers/billing'

// 员工「会员」页（2026-10-20 从「会员与计时」拆出来）：选中的人只跟会员动作走。
//
// ★ 以前「会员与计时」把选中会员的 accountId 和资产版本合进所有动作：先在「会员」标签选了张三，
//   再到「计时」标签确认李四的入座、给李四续时，请求里带着张三，审计记成了「张三 loyalty.confirm / renew」。
//   现在计时都在现场页和桌位弹层里办，这一页的 act 只交给充值、兑换、加减三个弹层和生日礼物核销。

function hooks() {
  const slots: any[] = []
  let cursor = 0
  const api = {
    useState(initial: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (next: any) => (slots[i] = typeof next === 'function' ? next(slots[i]) : next)]
    },
    useRef: (initial: any) => api.useState(() => ({ current: initial }))[0],
    useEffect() {},
  }
  return {
    api,
    render(fn: () => any) {
      cursor = 0
      return fn()
    },
  }
}

const reservationsModule = await load('services/reservations.ts', {
  './customer': { CustomerError: class extends Error {} },
  './staff': { request: async () => ({}) },
  './format': await load('services/format.ts'),
})
const at = (hour: number) => reservationsModule.storeInstant(reservationsModule.storeDate(0), hour * 60).toISOString()

test('会员页未选中时可扫会员码，扫码选中后隐藏按钮并清空搜索，换一位时恢复', async () => {
  const pageHooks = hooks()
  const { default: StaffMembership } = await load('pages/staff/membership/index.tsx', {
    react: pageHooks.api,
    '@tarojs/taro': { default: {}, useRouter: () => ({ params: {} }) },
    '../../../components/button': { Button: 'Button' },
    '../../../components/customer': { SectionEmpty: 'SectionEmpty', navbarHeight: () => 91 },
    '../../../components/staff': {
      StaffScreen: 'Screen',
      useStaffEvents: () => ({ refetchInterval: 5000 }),
      useStaffQuery: () => ({ data: null, error: null }),
    },
    '../../../components/staff/account-search': { AccountSearch: 'AccountSearch' },
    '../../../components/staff/table-sheet': { StaffSheet: 'StaffSheet' },
    '../../../hooks/customer': { useCustomer: () => ({ account: { roles: ['clerk'] } }) },
    '../../../hooks/billing': billingMock(),
    '../../../hooks/leave-guard': { useLeaveGuard() {} },
    '../../../hooks/query': { useRefreshAll: () => async () => {} },
    '../../../hooks/staff-overview': { useStaffOverview: () => ({ data: null }) },
    './members': {
      AdjustSheet: 'AdjustSheet',
      ConsumptionSheet: 'ConsumptionSheet',
      OpenMemberSheet: 'OpenMemberSheet',
      EntryList: 'EntryList',
      ExchangeSheet: 'ExchangeSheet',
      RechargeSheet: 'RechargeSheet',
      WalletRow: 'WalletRow',
      MemberDoneSheet: 'MemberDoneSheet',
      pendingGifts: () => [],
    },
  })
  const searchHooks = hooks()
  const { AccountSearch } = await load('components/staff/account-search.tsx', {
    react: searchHooks.api,
    '../button': { Button: 'Button' },
    '../staff': { ActionButton: 'Button', Field: 'Field' },
    '../../hooks/server-search': {
      useServerSearch: () => ({ items: [], total: 0, page: 1, loading: false, error: '', ready: false }),
    },
  })
  const render = () => pageHooks.render(StaffMembership)
  const search = (tree: unknown) => nodes(tree, (n) => n.type === 'AccountSearch')[0]
  const scanButtons = (tree: unknown) => {
    const content = searchHooks.render(() =>
      AccountSearch({
        ...search(tree).props,
        scanCode: async () => ({ kind: 'found', account: { id: 'lin', nickname: '小林', phoneMasked: '138****8888' } }),
      }),
    )
    return nodes(content, (n) => n.type === 'Button' && label(n) === '扫会员码')
  }

  let tree = render()
  assert.equal(
    nodes(tree, (n) => n.type === 'SectionEmpty')[0].props.message,
    '扫顾客的会员码，或按昵称、手机尾号、完整手机号查找，选中后办理充值、兑换、加减或核销生日礼物。',
  )
  assert.equal(scanButtons(tree).length, 1)
  search(tree).props.onKeyword('8888')
  tree = render()
  assert.equal(search(tree).props.keyword, '8888')
  scanButtons(tree)[0].props.onClick()
  await settle()
  tree = render()
  assert.equal(search(tree).props.selected.id, 'lin')
  assert.equal(search(tree).props.keyword, '')
  assert.equal(scanButtons(tree).length, 0)

  nodes(tree, (n) => n.type === 'Button' && label(n) === '换一位')[0].props.onClick()
  assert.equal(scanButtons(render()).length, 1)
})

test('会员页：充值、兑换、加减、核销都带选中会员的编号和资产版本；这位顾客今天的预约直接开台', async () => {
  const { withChosenMember } = await load('services/membership.ts')
  const h = hooks()
  const sent: any[] = []
  const modals: string[] = []
  const modalHeads: string[] = []
  const navigations: unknown[] = []
  const opened: unknown[] = []
  let role = 'clerk'
  const member = (id: string) => ({
    version: `version-of-${id}`,
    balance: { tierName: '银卡', principalCents: 0, giftCents: 0, points: 0, boardUses: 2 },
    profile: { birthday: '' },
    entries: [{ id: 'gift-1', kind: 'birthday', rule: { name: '生日小挂件', scope: 'gift' } }],
  })
  const overview = {
    tables: [{ id: 't-B3', code: 'B3' }],
    sessions: [{ id: 's1', accountId: 'zhang', serviceTableId: 't-B3', startedAt: at(13) }],
    reservations: [
      {
        displayStatus: 'confirmed',
        reservation: { id: 'r1', accountId: 'zhang', startAt: at(15), packageName: '两小时' },
        endAt: at(17),
        tableNumber: 3,
      },
      { displayStatus: 'confirmed', reservation: { id: 'r2', accountId: 'li', startAt: at(15) }, endAt: at(16) },
    ],
  }
  const { default: StaffMembership } = await load('pages/staff/membership/index.tsx', {
    '../../hooks/billing': billingMock(),
    react: h.api,
    '@tarojs/components': { View: 'View', Text: 'Text' },
    '@tarojs/taro': {
      default: {
        showModal: async (modal: { title: string; content: string; confirmText?: string }) => {
          modals.push(modal.content)
          modalHeads.push(`${modal.title}/${modal.confirmText}`)
          return { confirm: true }
        },
        showToast: async () => {},
      },
      useRouter: () => ({ params: {} }),
    },
    '../../../components/button': { Button: 'Button' },
    '../../../components/customer': { SectionEmpty: 'SectionEmpty', navbarHeight: () => 91 },
    '../../../components/staff': {
      StaffScreen: 'Screen',
      useStaffEvents: () => ({ connection: 'connected', refetchInterval: 5000 }),
      useStaffQuery: (key: string[]) => ({ data: key[1] ? member(key[1]) : null, error: null }),
    },
    '../../../components/staff/account-search': { AccountSearch: 'AccountSearch' },
    '../../../components/staff/table-sheet': { StaffSheet: 'StaffSheet' },
    '../../../services/navigation': { navigateApp: async (...args: unknown[]) => navigations.push(args) },
    '../../../hooks/customer': { useCustomer: () => ({ account: { roles: [role] } }) },
    '../../../hooks/leave-guard': { useLeaveGuard() {} },
    '../../../hooks/query': { useRefreshAll: () => async () => {} },
    '../../../hooks/staff-overview': { useStaffOverview: () => ({ data: overview }) },
    '../../../services/membership': {
      loyalty: {
        action: async (input: any) => {
          sent.push(input)
          return {
            ...member(input.accountId),
            entries: [...member(input.accountId).entries, { id: 'new-' + input.action, kind: input.action }],
          }
        },
        openAccount: async (input: unknown) => {
          opened.push(input)
          return { existing: true, account: { id: 'li', nickname: '小李', unclaimed: true } }
        },
      },
      withChosenMember,
    },
    '../../../services/reservations': {
      ...reservationsModule,
      reservations: { action: async (input: unknown) => sent.push(['reservation', input]) },
    },
    '../../../services/staff': {
      staffMessage: (e: unknown) => String(e),
      staffApi: {
        issueTemporaryPassword: async (id: string) => {
          sent.push(['password', id])
          return { temporaryPassword: '73914026', expiresAt: at(23), phoneMasked: '138****1234' }
        },
      },
    },
    './members': {
      AdjustSheet: 'AdjustSheet',
      ConsumptionSheet: 'ConsumptionSheet',
      OpenMemberSheet: 'OpenMemberSheet',
      EntryList: 'EntryList',
      ExchangeSheet: 'ExchangeSheet',
      RechargeSheet: 'RechargeSheet',
      WalletRow: 'WalletRow',
      MemberDoneSheet: 'MemberDoneSheet',
      pendingGifts: (m: ReturnType<typeof member>) => m.entries,
    },
    './index.scss': {},
  })
  const render = () => h.render(StaffMembership)
  const button = (tree: unknown, start: string) =>
    nodes(tree, (node) => node.type === 'Button' && label(node).startsWith(start))[0]

  let tree = render()
  assert.equal(nodes(tree, (node) => node.type === 'SectionEmpty').length, 1)
  nodes(tree, (node) => node.type === 'AccountSearch')[0].props.onSelect({
    id: 'zhang',
    nickname: '张三',
    phoneMasked: '138****1234',
  })
  tree = render()
  assert.equal(nodes(tree, (node) => node.type === 'AccountSearch').length, 1)
  assert.equal(nodes(tree, (node) => node.type === 'AccountSearch')[0].props.showResults, false)
  assert.equal(
    label(nodes(tree, (node) => node.props.className === 'member-card-meta')[0]),
    '银卡 · 尾号 1234 · 没填生日',
  )

  button(tree, '到店充值').props.onClick()
  const recharge = nodes(render(), (node) => node.type === 'RechargeSheet')[0]
  assert.ok(recharge, '点「到店充值」从底部弹出')
  await recharge.props.act({ action: 'recharge', targetId: 'rule', method: 'cash' })
  button(render(), '手动加减').props.onClick()
  const adjust = nodes(render(), (node) => node.type === 'AdjustSheet')[0] as any
  assert.equal(adjust.key, 'zhang', '换一位会员时表单重来')
  // 生日礼物待领：交给顾客后点核销，先确认
  button(render(), '核销').props.onClick()
  await settle()
  assert.deepEqual(modals, ['确认交付生日礼物并扣减库存？'])
  assert.deepEqual(modalHeads, ['交付生日礼物/确认交付'], '确认框的标题和按钮写动作')

  // 这位顾客今天：只列这位自己的预约，开台前问一句；正在计时的桌点了去桌位打开那张桌
  tree = render()
  assert.deepEqual(nodes(tree, (node) => node.props.className === 'member-today-title').map(label), [
    `预约 ${reservationsModule.storeClock(at(15))}–${reservationsModule.storeClock(at(17))} · 3 号桌`,
    `B3 计时中 · ${reservationsModule.storeClock(at(13))} 开始`,
  ])
  button(tree, '开台').props.onClick()
  await settle()
  assert.equal(
    modals.at(-1),
    `给 张三 按「两小时」从现在开始计时（预约 ${reservationsModule.storeClock(at(15))} · 3 号桌）。`,
    '已确认的不提通知',
  )
  button(render(), 'B3 计时中').props.onClick()
  assert.deepEqual(navigations.at(-1), ['/pages/staff/tables/index?tableId=t-B3', true])

  assert.deepEqual(sent, [
    { expectedVersion: 'version-of-zhang', action: 'recharge', targetId: 'rule', method: 'cash', accountId: 'zhang' },
    { expectedVersion: 'version-of-zhang', action: 'fulfill_gift', targetId: 'gift-1', accountId: 'zhang' },
    ['reservation', { action: 'seat', targetId: 'r1' }],
  ])

  // 发临时密码：先问（之前发的作废），临时密码在弹层里给店员看一次，说明只讲小程序认领
  button(render(), '发临时密码').props.onClick()
  await settle()
  assert.match(modals.at(-1)!, /在小程序登录页认领会员用；之前发的作废/)
  assert.deepEqual(sent.at(-1), ['password', 'zhang'])
  const issued = nodes(render(), (node) => node.type === 'StaffSheet')[0]
  assert.equal(issued.props.title, '临时密码')
  assert.ok(label(issued).includes('73914026'))
  assert.ok(issued.props.meta.startsWith('认领手机号 138****1234 · 有效到 '))
  assert.ok(label(issued).includes('店员帮我开过会员，去认领'))
  assert.doesNotMatch(label(issued), /网页/)
  nodes(issued.props.footer, (node) => node.type === 'Button')[0].props.onClick()
  assert.equal(nodes(render(), (node) => node.type === 'StaffSheet').length, 0, '「已告诉顾客」收起，关掉就看不到了')

  button(render(), '消费登记').props.onClick()
  let consume = nodes(render(), (node) => node.type === 'ConsumptionSheet')[0]
  assert.equal(consume.props.unlimitedDates, false)
  const input = {
    action: 'consume',
    serviceDate: '2026-10-25',
    consumption: { headcount: 1, dayType: 'holiday', amountCents: 7990, boardUses: 1 },
  }
  await consume.props.act(input)
  assert.deepEqual(sent.at(-1), { ...input, expectedVersion: 'version-of-zhang', accountId: 'zhang' })
  role = 'owner'
  consume = nodes(render(), (node) => node.type === 'ConsumptionSheet')[0]
  assert.equal(consume.props.unlimitedDates, true)
  const done = nodes(render(), (node) => node.type === 'MemberDoneSheet')[0]
  assert.equal(done.props.entry.id, 'new-consume')
  done.props.onClose()
  nodes(render(), (node) => node.type === 'AccountSearch')[0].props.inputAction.props.onClick()
  const open = nodes(render(), (node) => node.type === 'OpenMemberSheet')[0]
  const accountInput = { nickname: '小李', phone: '13800005678', consent: true }
  assert.equal(await open.props.open(accountInput), true)
  assert.deepEqual(opened, [accountInput])
  assert.match(label(render()), /这个手机号已经有账户，已为你打开/)
  assert.match(label(render()), /店员代开 · 未认领/)
  assert.match(label(render()), /小程序登录页认领/)
  button(render(), '换一位').props.onClick()
  assert.equal(nodes(render(), (node) => node.type === 'AccountSearch').length, 1)
})
