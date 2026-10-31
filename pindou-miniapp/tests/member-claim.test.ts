import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { test } from 'vitest'
import * as customerLib from '../src/services/customer'
import { load, src } from './helpers/load'
import { label, nodes, settle } from './helpers/tree'

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
const button = (tree: unknown, text: string) => nodes(tree, (n) => n.type === 'Button' && label(n) === text)[0]
const input = (tree: unknown, name: string, value: string) =>
  nodes(tree, (n) => n.type === 'Input' && n.props.ariaLabel === name)[0].props.onInput({ detail: { value } })
const agree = (tree: unknown) =>
  nodes(tree, (n) => n.type === 'CheckboxGroup')[0].props.onChange({ detail: { value: ['privacy'] } })

async function page(file: string, customer: any, extra: Record<string, unknown> = {}) {
  const h = hooks()
  const navigated: string[] = []
  let authorized = 0,
    cleared = 0
  let unload: (() => void) | undefined
  const { default: Page } = await load(file, {
    react: h.api,
    '../../../services/customer': customerLib,
    '../../../components/button': { Button: 'Button' },
    '../../../components/customer': { Screen: 'Screen' },
    '../../../components/customer/wechat-privacy': { WechatPrivacy: 'WechatPrivacy' },
    '../../../components/customer/avatar-picker': { AvatarPicker: 'AvatarPicker' },
    '../../../components/customer/bead-heart': { BeadHeart: 'BeadHeart' },
    '../../../hooks/query': { useCustomerQuery: () => ({ data: null, loading: false, refresh() {} }) },
    '../../../hooks/leave-guard': { useLeaveGuard() {} },
    '../../../hooks/customer': { useCustomer: () => ({ status: 'anonymous' }) },
    '../../../services/login-hint': { loginHint: () => '' },
    '../../../services/platform': {
      customer,
      authorizePrivacy: async () => {
        authorized++
      },
      openPrivacy() {},
      privacyVersion: 'privacy-test-v1',
    },
    '../../../services/navigation': {
      clearLoginTarget() {
        cleared++
      },
      completeLogin() {},
      confirmLeave: async () => true,
      pendingLoginTarget: () => '/pages/customer/reservations/index',
      navigateApp: async (url: string) => navigated.push(url),
    },
    '@tarojs/taro': {
      default: {},
      useRouter: () => ({ params: { phone: '13800005678' } }),
      useDidShow() {},
      useUnload(callback) {
        unload = callback
      },
    },
    ...extra,
  })
  return {
    render: () => h.render(Page),
    navigated,
    authorized: () => authorized,
    cleared: () => cleared,
    unload: () => unload?.(),
  }
}

test('认领页：默认不勾隐私，勾选后先微信授权再认领，携带手机号、密码和隐私版本', async () => {
  const sent: any[] = []
  const h = await page('pages/customer/member-claim/index.tsx', { claimMember: async (data) => sent.push(data) })
  let tree = h.render()
  assert.equal(nodes(tree, (n) => n.type === 'Checkbox')[0].props.checked, false)
  assert.equal(nodes(tree, (n) => n.type === 'Input' && n.props.ariaLabel === '手机号')[0].props.value, '13800005678')
  input(tree, '临时密码或网页密码', '12345678')
  tree = h.render()
  button(tree, '绑定并登录').props.onClick()
  await settle()
  tree = h.render()
  assert.match(label(tree), /请先阅读并同意隐私协议/)
  assert.equal(sent.length, 0)
  assert.equal(h.authorized(), 0)
  agree(tree)
  tree = h.render()
  button(tree, '绑定并登录').props.onClick()
  button(tree, '绑定并登录').props.onClick()
  await settle()
  assert.equal(h.authorized(), 1)
  assert.deepEqual(sent, [{ phone: '13800005678', password: '12345678', privacyContractVersion: 'privacy-test-v1' }])
})

test('认领页按错误码给中文提示，失败保留手机号和密码', async () => {
  for (const [code, message] of Object.entries({
    invalid_credentials: '手机号或密码不对',
    temporary_password_expired: '临时密码已过期',
    already_claimed: '这个会员已经被认领了，不是你本人操作的话请联系店员',
    already_registered: '你已经有账号了，请直接登录',
    rate_limited: '操作太频繁',
  })) {
    const h = await page('pages/customer/member-claim/index.tsx', {
      claimMember: async () => {
        throw new customerLib.CustomerError(code, customerLib.messageForCode(code, 409), 409)
      },
    })
    let tree = h.render()
    input(tree, '临时密码或网页密码', '12345678')
    agree(tree)
    tree = h.render()
    button(tree, '绑定并登录').props.onClick()
    await settle()
    tree = h.render()
    assert.ok(label(tree).includes(message), `${code}: ${label(tree)}`)
    assert.equal(nodes(tree, (n) => n.type === 'Input' && n.props.password)[0].props.value, '12345678')
  }
})

test('认领页可显示隐藏密码；成功留当前页显示余额、豆板和历史笔数，再去看会员', async () => {
  const calls: any[] = []
  const h = await page(
    'pages/customer/member-claim/index.tsx',
    { claimMember: async (...args) => calls.push(args) },
    {
      '../../../hooks/customer': { useCustomer: () => ({ account: { nickname: '小林' } }) },
      '../../../hooks/query': {
        useCustomerQuery: () => ({
          data: {
            balance: { principalCents: 80810, giftCents: 12000, boardUses: 1 },
            entries: [{}, {}, {}, { kind: 'consume_reverse' }],
          },
          loading: false,
        }),
      },
    },
  )
  let tree = h.render()
  input(tree, '临时密码或网页密码', '12345678')
  nodes(tree, (n) => n.type === 'Button' && n.props.ariaLabel === '显示密码')[0].props.onClick()
  tree = h.render()
  assert.equal(
    nodes(tree, (n) => n.type === 'Input' && n.props.ariaLabel === '临时密码或网页密码')[0].props.password,
    false,
  )
  nodes(tree, (n) => n.type === 'Button' && n.props.ariaLabel === '隐藏密码')[0].props.onClick()
  tree = h.render()
  agree(tree)
  tree = h.render()
  button(tree, '绑定并登录').props.onClick()
  await settle()
  tree = h.render()
  assert.equal(calls[0][1], false, '保存会话时不触发自动跳转')
  assert.deepEqual(h.navigated, [])
  for (const copy of ['欢迎回来，小林', '¥928.10', '其中赠送 ¥120.00', '智能豆板1 次', '以前的 3 笔记录已在「明细」里'])
    assert.ok(label(tree).includes(copy), copy)
  assert.equal(tree.props.title, '示例工坊社')
  assert.doesNotMatch(label(tree), /开启消费提醒/)
  button(tree, '去看会员').props.onClick()
  assert.equal(h.navigated.at(-1), '/pages/customer/membership/index')
})

test('小程序注册撞号：提示去认领并带上手机号；登录页有认领入口', async () => {
  const h = await page('pages/register/index.tsx', {
    register: async () => {
      throw new customerLib.CustomerError('claim_required', customerLib.messageForCode('claim_required', 409), 409)
    },
  })
  let tree = h.render()
  button(tree, '店员帮我开过会员，去认领').props.onClick()
  assert.equal(h.navigated.at(-1), '/pages/customer/member-claim/index')
  button(tree, '第一次来？创建账号').props.onClick()
  tree = h.render()
  nodes(tree, (n) => n.type === 'Input' && n.props.type === 'nickname')[0].props.onInput({ detail: { value: '小林' } })
  button(tree, '换个号码，手动填写').props.onClick()
  tree = h.render()
  nodes(tree, (n) => n.type === 'Input' && n.props.ariaLabel === '手机号')[0].props.onInput({
    detail: { value: '13800005678' },
  })
  agree(tree)
  tree = h.render()
  button(tree, '完成注册').props.onClick()
  await settle()
  tree = h.render()
  assert.match(label(tree), /门店已经用这个手机号为你开过会员/)
  button(tree, '去认领会员').props.onClick()
  assert.equal(h.navigated.at(-1), '/pages/customer/member-claim/index?phone=13800005678')
  h.unload()
  assert.equal(h.cleared(), 0, '跳去认领时保留登录前的目标')
})

/** 源码里会显示出来的文字：字符串、模板字符串和 JSX 文字（注释不算）。 */
function visibleTexts(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(src, file), 'utf8'), ts.ScriptTarget.Latest, true)
  const texts: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node))
      texts.push(node.text)
    if (ts.isTemplateExpression(node))
      texts.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return texts
}

// 2026-10-28 0.0.37 提审被驳回：调手机号快速验证组件的页面和它前面的登录页有「微信」字样、微信图标，
// 算混淆腾讯官方的元素。报错在内的文字都查（审核员点到哪句都可能），登录按钮实际渲染一次查图标。
test('登录、创建账号、认领、编辑资料页不写「微信」，登录按钮不带微信图标', async () => {
  for (const file of [
    'pages/register/index.tsx',
    'pages/customer/member-claim/index.tsx',
    'pages/customer/profile-edit/index.tsx',
    'components/customer/wechat-privacy.tsx',
    'components/customer/avatar-picker.tsx',
    'services/phone-authorization.ts',
    'services/platform.ts',
  ])
    assert.deepEqual(
      visibleTexts(file).filter((text) => text.includes('微信')),
      [],
      file,
    )
  for (const code of [
    'not_registered',
    'already_registered',
    'already_claimed',
    'claim_required',
    'wechat_unavailable',
  ])
    assert.doesNotMatch(customerLib.messageForCode(code, 409), /微信/, code)

  const h = await page('pages/register/index.tsx', {})
  let tree = h.render()
  assert.ok(button(tree, '一键登录'))
  // 没勾协议就点登录：提示写在勾选框下面，不弹两秒就没的轻提示；勾上就消失
  button(tree, '一键登录').props.onClick()
  await settle()
  tree = h.render()
  const consent = () => nodes(h.render(), (n) => n.props?.className?.includes?.('register-consent-error'))
  assert.equal(label(consent()[0]), '请先阅读并勾选同意隐私协议')
  assert.equal(consent()[0].props.role, 'alert')
  agree(tree)
  assert.equal(consent().length, 0)
  tree = h.render()
  assert.deepEqual(
    nodes(tree, (n) => n.props?.name === 'wechat'),
    [],
  )
  button(tree, '第一次来？创建账号').props.onClick()
  tree = h.render()
  const phone = nodes(tree, (n) => n.props?.openType === 'getPhoneNumber')[0]
  assert.match(label(phone), /手机号快捷填写/)
  phone.props.onError({ detail: { errMsg: 'getPhoneNumber:fail jsapi has no permission', errno: 102 } })
  tree = h.render()
  assert.match(label(tree), /暂无法快捷填写手机号/)
  assert.match(label(tree), /改用快捷填写/)
  assert.doesNotMatch(label(tree), /微信/)
})

test('微信隐私授权：拒绝或同意都交回微信回调，回到登录页可重新接管', async () => {
  const h = hooks()
  let handler: any, didShow: any
  const resolved: any[] = []
  const { WechatPrivacy } = await load('components/customer/wechat-privacy.tsx', {
    react: { ...h.api, useEffect: (effect) => effect() },
    '@tarojs/taro': {
      default: {
        onNeedPrivacyAuthorization: (callback) => {
          handler = callback
        },
      },
      useDidShow: (callback) => {
        didShow = callback
      },
    },
    '../button': { Button: 'Button' },
    '../../services/platform': { openPrivacy() {} },
  })
  h.render(WechatPrivacy)
  handler((value) => resolved.push(value))
  let tree = h.render(WechatPrivacy)
  button(tree, '暂不同意').props.onClick()
  assert.deepEqual(resolved, [{ event: 'disagree' }])
  didShow()
  handler((value) => resolved.push(value))
  tree = h.render(WechatPrivacy)
  button(tree, '同意并继续').props.onAgreePrivacyAuthorization()
  assert.deepEqual(resolved.at(-1), { event: 'agree', buttonId: 'privacy-agree' })
})
