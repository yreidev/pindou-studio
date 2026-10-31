import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ListedAccount } from '../api/staff'
import { dispatchScan } from '../realtime/scans'
import { saveSession } from '../session'
import { CustomerPicker } from './CustomerPicker'

const li: ListedAccount = {
  id: '00000000-0000-4000-8000-000000000001',
  nickname: '小李',
  phoneMasked: '139****0002',
  roles: [],
  phoneVerificationStatus: 'verified',
}
const wang: ListedAccount = {
  id: '00000000-0000-4000-8000-000000000002',
  nickname: '小王',
  phoneMasked: '138****0003',
  roles: [],
  phoneVerificationStatus: 'verified',
}

const zhao = {
  id: '00000000-0000-4000-8000-000000000003',
  nickname: '老赵',
  phoneMasked: '137****0004',
  roles: [],
  phoneVerificationStatus: 'verified',
  balance: {
    principalCents: 0,
    giftCents: 0,
    points: 0,
    expiringPoints: 0,
    tierName: '普通会员',
    rateBasisPoints: 10000,
  },
}
const zhaoCode = '91234567890123456789'
const expiredCode = '99999999999999999999'

/** 模拟 GET /accounts：按关键字在昵称里筛，记下每次查的关键字；POST /member-codes/lookups 认得老赵的码。 */
function backend() {
  const searched: string[] = []
  const lookups: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      const url = new URL(request.url)
      if (request.method === 'POST' && url.pathname.endsWith('/member-codes/lookups')) {
        const { code } = (await request.json()) as { code: string }
        lookups.push(code)
        return code === zhaoCode
          ? new Response(JSON.stringify(zhao), { status: 200, headers: { 'Content-Type': 'application/json' } })
          : new Response(
              JSON.stringify({
                code: 'member_code_expired',
                message: '会员码已过期，请顾客刷新会员码后再扫',
                requestId: 'r',
              }),
              { status: 410, headers: { 'Content-Type': 'application/json' } },
            )
      }
      const q = url.searchParams.get('q') ?? ''
      searched.push(q)
      const rows = [li, wang].filter((account) => account.nickname.includes(q))
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Total-Count': String(rows.length) },
      })
    }),
  )
  return Object.assign(searched, { lookups })
}

function Harness({ onChange }: { onChange: (account: ListedAccount | null) => void }) {
  const [value, setValue] = useState<ListedAccount | null>(null)
  return (
    <CustomerPicker
      label="选择顾客"
      value={value}
      onChange={(account) => {
        setValue(account)
        onChange(account)
      }}
    />
  )
}

function mount(onChange: (account: ListedAccount | null) => void = () => {}) {
  saveSession({
    accessToken: 'web-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: 'u-clerk', nickname: '店员', roles: ['clerk'] },
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <Harness onChange={onChange} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('选顾客账户', () => {
  it('下拉框有名字；选中的人在换了关键字、搜不到他之后仍显示在框里', async () => {
    const searched = backend()
    const chosen = vi.fn()
    mount(chosen)
    const box = screen.getByRole('combobox', { name: '选择顾客' })
    // 一挂上就按空关键字查了一次：等它回来再展开。选中后受控的下拉框要等收起动画放完才调 onChange，
    // 所以下面用 waitFor 等（jsdom 里动画怎么「放完」见 src/test/setup.ts）
    await waitFor(() => expect(searched).toContain(''))
    await userEvent.click(box)
    await userEvent.click(await screen.findByRole('option', { name: /小李/ }))
    await waitFor(() => expect(chosen).toHaveBeenLastCalledWith(li))
    expect(box.textContent).toContain('小李（139****0002）')

    // 再搜「王」：结果里没有小李，但他仍是选中的人，框里照样写着他（不能空着、也不能露出账号编号）
    await userEvent.click(box)
    await userEvent.type(screen.getByRole('textbox', { name: '选择顾客' }), '王')
    await waitFor(() => expect(searched).toContain('王'))
    expect(await screen.findByRole('option', { name: /小王/ })).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(box.textContent).toContain('小李（139****0002）'))
    expect(box.textContent).not.toContain(li.id)
    expect(chosen).toHaveBeenCalledTimes(1)

    // 谁都搜不到：照说没有匹配，不把选中的人塞进结果里冒充
    // （浏览器里收起时 Semi 会清空搜索框并报空关键字；jsdom 不放收起动画、走不到这一步，这里手动清掉）
    await userEvent.click(box)
    const search = screen.getByRole('textbox', { name: '选择顾客' })
    await userEvent.clear(search)
    await userEvent.type(search, '张')
    await waitFor(() => expect(searched.at(-1)).toBe('张'))
    expect(await screen.findByText('没有匹配的顾客，请先引导顾客注册')).toBeTruthy()
    expect(screen.queryByRole('option', { name: /小李/ })).toBeNull()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(box.textContent).toContain('小李（139****0002）'))
  })
})

describe('扫会员码选顾客', () => {
  it('扫码枪对着搜索框扫会员码再回车：按码查人直接选中，不按关键字搜，也不把高亮的第一位当成选中', async () => {
    const searched = backend()
    const chosen = vi.fn()
    mount(chosen)
    const box = screen.getByRole('combobox', { name: '选择顾客' })
    await waitFor(() => expect(searched).toContain(''))
    await userEvent.click(box)
    expect(await screen.findByRole('option', { name: /小王/ })).toBeTruthy()
    // 扫码枪等于键盘输入再回车
    await userEvent.type(screen.getByRole('textbox', { name: '选择顾客' }), `${expiredCode}{Enter}`)
    expect(await screen.findByText('会员码已过期，请顾客刷新会员码后再扫')).toBeTruthy()
    expect(chosen).not.toHaveBeenCalled()
    expect(screen.queryByRole('option', { name: /小王/ })).toBeNull()

    const search = screen.getByRole('textbox', { name: '选择顾客' })
    await userEvent.clear(search)
    await userEvent.type(search, `${zhaoCode}{Enter}`)
    await waitFor(() =>
      expect(chosen).toHaveBeenLastCalledWith(expect.objectContaining({ id: zhao.id, nickname: '老赵' })),
    )
    expect(chosen).toHaveBeenCalledTimes(1)
    // 选中的只带账户字段，资产摘要不进表单
    expect(chosen.mock.calls[0][0]).not.toHaveProperty('balance')
    expect(searched.lookups).toEqual([expiredCode, zhaoCode])
    expect(searched).not.toContain(zhaoCode)
    await waitFor(() => expect(box.textContent).toContain('老赵（137****0004）'))
  })

  it('手机「扫码给电脑」转来的会员码同样选中；转来的商品条码不认领', async () => {
    const searched = backend()
    const chosen = vi.fn()
    mount(chosen)
    await waitFor(() => expect(searched).toContain(''))
    let claimed = false
    act(() => {
      claimed = dispatchScan('6901234567892')
    })
    expect(claimed).toBe(false)
    act(() => {
      claimed = dispatchScan(zhaoCode)
    })
    expect(claimed).toBe(true)
    await waitFor(() => expect(chosen).toHaveBeenLastCalledWith(expect.objectContaining({ id: zhao.id })))
  })
})
