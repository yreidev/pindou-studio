import { act, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchScan, isBarcode, isMemberCode, memberCodeIn, receiveScan, useScanRelay, type ScanClaim } from './scans'

const notify = vi.hoisted(() => vi.fn())
vi.mock('@douyinfe/semi-ui', async (original) => ({
  ...(await original<typeof import('@douyinfe/semi-ui')>()),
  Notification: { info: notify },
}))

afterEach(() => {
  notify.mockReset()
})

const memberCode = '91234567890123456789'

describe('手机转来的码', () => {
  it('会员码、商品条码的样子', () => {
    expect(isMemberCode(memberCode)).toBe(true)
    expect(isMemberCode(` ${memberCode}\n`)).toBe(true)
    for (const other of ['6901234567892', '13800138000', `8${memberCode.slice(1)}`, `${memberCode}0`, ''])
      expect(isMemberCode(other)).toBe(false)
    expect(isBarcode('6901234567892')).toBe(true)
    expect(isBarcode('Ab-12/x')).toBe(true)
    expect(isBarcode(memberCode)).toBe(false)
    expect(isBarcode('有中文')).toBe(false)
    expect(isBarcode('a b')).toBe(false)
  })

  it('搜索框里扫进来的会员码：整串，或接在原有文字后面；前面紧挨着数字的不算', () => {
    expect(memberCodeIn(memberCode)).toBe(memberCode)
    expect(memberCodeIn(`小${memberCode}`)).toBe(memberCode)
    expect(memberCodeIn(`小 ${memberCode}\r\n`)).toBe(memberCode)
    expect(memberCodeIn(`1${memberCode}`)).toBe('')
    expect(memberCodeIn('13800138000')).toBe('')
  })

  it('后挂上的先认领；不认的交给下一个；不认领时、卸下后都不再认领；都不认就在角上提示、可复制', () => {
    const page = vi.fn<ScanClaim>((code) => code === 'page')
    const picker = vi.fn<ScanClaim>((code) => isMemberCode(code))
    const first = renderHook(() => useScanRelay(page))
    const second = renderHook(({ on }) => useScanRelay(on ? picker : null), { initialProps: { on: true } })

    expect(dispatchScan(memberCode)).toBe(true)
    expect(picker).toHaveBeenCalledWith(memberCode)
    expect(page).not.toHaveBeenCalled()
    expect(dispatchScan('page')).toBe(true)
    expect(page).toHaveBeenCalledWith('page')

    // claim 为 null（例如下拉框禁用）时不认领
    second.rerender({ on: false })
    picker.mockClear()
    expect(dispatchScan(memberCode)).toBe(false)
    expect(picker).not.toHaveBeenCalled()

    first.unmount()
    second.unmount()
    act(() => receiveScan('6901234567892'))
    expect(notify).toHaveBeenCalledOnce()
    const options = notify.mock.calls[0][0]
    expect(options).toMatchObject({ title: '手机扫到', position: 'bottomRight', duration: 8 })
    const { container } = render(options.content)
    expect(container.textContent).toContain('6901234567892')
    expect(container.textContent).toContain('收货入库会按条码加商品')
  })
})
