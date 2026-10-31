import { Toast, Typography } from '@douyinfe/semi-ui'
import { useDebouncedValue } from '@tanstack/react-pacer'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { asListedAccount, memberCodesApi } from '../api/member-codes'
import { accountSearchQuery, type ListedAccount } from '../api/staff'
import { isMemberCode, memberCodeIn, useScanRelay } from '../realtime/scans'
import { NamedSelect, type SelectInstance } from './NamedSelect'

/**
 * 选顾客账户（看板上开台、散客预约到店开台，结账页绑定或更换订单的顾客，代客登记预约）：关键字在服务端筛
 * （GET /accounts?q=&pageSize=20），输入停下 300 毫秒才查；没输入时列出最新注册的一批（顾客多半刚在店里注册）。
 *
 * 会员码（2026-10-06）：柜台 USB 扫码枪对着搜索框扫顾客手机上的会员码（扫码枪等于键盘输入再回车），
 * 框里一出现会员码的样子（首位 9 的 20 位数字）就按码查人、直接选中，不按关键字搜；本人手机「扫码给电脑」
 * 转来的会员码也一样。查不到（过期、不是本店的码）在下拉框里照后端的话说明。
 */
export function CustomerPicker({
  label,
  value,
  onChange,
  disabled = false,
  clearable = false,
  focusOnMount = false,
}: {
  /** 读屏念的名字（下拉框与其中的搜索框）；页面上已有标题说明，这里不另外显示。 */
  label: string
  value: ListedAccount | null
  onChange: (account: ListedAccount | null) => void
  disabled?: boolean
  /** 选中后可以清掉（回到没选人，例如开台改回散客）。 */
  clearable?: boolean
  /** 挂上时把焦点放到下拉框上（弹窗里只有选人这一件事时），不展开列表。 */
  focusOnMount?: boolean
}) {
  const select = useRef<SelectInstance>(null)
  // 最近一次在框里扫到会员码的时刻：紧跟着的回车（扫码枪的结尾）一律拦下，查人可能已经回来、框已清空
  const scannedAt = useRef(0)
  const [keyword, setKeyword] = useState('')
  // 框里是会员码时不按关键字搜（搜不到任何人，还会把上一批候选留着让回车误选）
  const scanned = memberCodeIn(keyword)
  const [q] = useDebouncedValue(scanned ? '' : keyword.trim(), { wait: 300 })
  const accounts = useQuery(accountSearchQuery({ q: q || undefined, page: 1, pageSize: 20 }))
  const lookup = useMutation({
    mutationFn: memberCodesApi.lookup,
    onSuccess: (account) => {
      onChange(asListedAccount(account))
      // 收起下拉框（Semi 收起时会清空搜索框），框里显示选中的人
      select.current?.close()
      setKeyword('')
      Toast.success(`已按会员码选中「${account.nickname}」`)
    },
  })
  const { mutate } = lookup
  useEffect(() => {
    if (scanned) mutate(scanned)
  }, [scanned, mutate])
  // 手机「扫码给电脑」转来的会员码：同样查人、选中（禁用时不认领，交给页面或提示）
  useScanRelay(
    disabled
      ? null
      : (code) => {
          if (!isMemberCode(code)) return false
          mutate(code.trim())
          return true
        },
  )
  // 候选与选中值都缓存住：Semi 每次渲染都深比较它们，内容没变就别给新对象
  const options = useMemo(
    () => (scanned ? [] : (accounts.data?.rows ?? []).map(accountOption)),
    [accounts.data, scanned],
  )
  const selected = useMemo(() => (value ? accountOption(value) : undefined), [value])
  const scanState = lookup.isError ? lookup.error.message : '正在按会员码查找顾客…'
  // 扫码枪打完会员码会按回车：在捕获阶段拦下，不让 Semi 把高亮的候选当成选中（候选此时已清空，这里再保险一道）。
  // 查人回来得快时下拉框已收起、焦点回到选择框本身，这个回车也不能让它又展开，所以拦在外层，不只拦搜索框
  const swallowScanEnter = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter') return
    const typed = event.target instanceof HTMLInputElement ? event.target.value : ''
    if (memberCodeIn(typed) || Date.now() - scannedAt.current < scanEnterWindow) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  return (
    <div onKeyDownCapture={swallowScanEnter}>
      {/* Semi 的下拉框不收 aria-label（它自己在选中后写成 selected），名字由 NamedSelect 经 aria-labelledby 接上 */}
      <NamedSelect
        label={label}
        selectRef={select}
        focusOnMount={focusOnMount}
        style={{ width: '100%' }}
        filter
        remote
        disabled={disabled}
        showClear={clearable}
        onSearch={(input: string) => {
          setKeyword(input)
          if (memberCodeIn(input)) scannedAt.current = Date.now()
          else lookup.reset()
        }}
        placeholder="搜昵称、手机尾号或账号编号，或扫会员码"
        loading={!scanned && (accounts.isPending || accounts.isPlaceholderData)}
        // 选中的值连人一起交给 Semi（onChangeWithObject）：换了关键字、这批结果里没有选中的人时，
        // 只给编号的话 Semi 找不到对应的候选，框里就空了（人其实还选着，点确认会提交他）
        onChangeWithObject
        value={selected}
        onChange={(option) => onChange((option as AccountOption | undefined)?.account ?? null)}
        renderSelectedItem={(option: Record<string, unknown>) => String(option.text ?? '')}
        optionList={options}
        emptyContent={
          scanned
            ? scanState
            : accounts.isError
              ? accounts.error.message
              : q
                ? '没有匹配的顾客，请先引导顾客注册'
                : '还没有注册的顾客'
        }
      />
    </div>
  )
}

/** 扫到会员码之后多久内的回车算扫码枪的结尾（毫秒）。 */
const scanEnterWindow = 1500

type AccountOption = { value: string; text: string; label: ReactNode; account: ListedAccount }

function accountOption(account: ListedAccount): AccountOption {
  return {
    value: account.id,
    text: account.phoneMasked ? `${account.nickname}（${account.phoneMasked}）` : account.nickname,
    label: (
      <div>
        <div>{account.nickname}</div>
        <Typography.Text type="tertiary" size="small">
          {account.phoneMasked || account.id.slice(0, 8)}
        </Typography.Text>
      </div>
    ),
    account,
  }
}
