import { useState, type ReactNode } from 'react'
import { Text, View } from '@tarojs/components'
import { membershipName } from '../../brand'
import { Button } from '../button'
import { ActionButton, Field } from '../staff'
import { PageControls } from '../pagination'
import { useServerSearch } from '../../hooks/server-search'
import { scanMemberCode, type MemberScan } from '../../services/member-code'
import { staffApi, type Page } from '../../services/staff'

/** 列表里选中的人：只要编号和给人看的称呼。选中后由调用方留着，换了关键字也还能显示是谁。 */
export type AccountChoice = { id: string; nickname: string; phoneMasked?: string; unclaimed?: true }

const nameOf = (account: AccountChoice) => account.nickname || '未命名顾客'
const phoneOf = (account: AccountChoice) => account.phoneMasked || '未绑定手机'
export const accountText = (account: AccountChoice) =>
  `${nameOf(account)} · ${phoneOf(account)}${account.unclaimed ? ' · 店员代开 · 未认领' : ''}`

/**
 * 员工找顾客 / 会员：输入关键字，服务端筛选，列出这一页的人供点选。
 *
 * ★ 不再把全店账户整表拉到手机上筛（也不再用原生 Picker 摆全店名单）：关键字交给
 *   服务端，停顿 300ms 才查。没输关键字时列出的是服务端默认顺序的第一页
 *   （账户：最近注册的在前；会员：按昵称拼音），`hint` 写清楚是哪一种。
 * ★ 选中的人不在当前结果里（换了关键字）时仍钉在列表最前，避免「选了谁看不见」。
 * ★ 不用 slot 默认内容：小程序的插槽语义与 Vue 不同，调用方的条件插槽会吃掉默认内容。
 * ★ `scan` 时上面多一个「扫会员码」：扫顾客手机上会员中心的二维码，后端认出是谁就直接选中（2026-10-06）。
 */
export function AccountSearch({
  label = '搜索顾客',
  keyword,
  onKeyword,
  selected,
  onSelect,
  disabled = false,
  limit = 20,
  paged = false,
  guest = false,
  refetchInterval,
  resource = 'accounts',
  load = staffApi.searchAccounts,
  hint = '未输入关键字时列出最近注册的顾客。',
  empty = '没有匹配的顾客，可换个关键字，或先引导顾客注册。',
  scan = false,
  scanCode = scanMemberCode,
  inputAction,
  showResults = true,
  placeholder = '昵称、手机尾号或完整手机号',
}: {
  label?: string
  keyword: string
  onKeyword: (value: string) => void
  selected: AccountChoice | null
  onSelect: (account: AccountChoice | null) => void
  disabled?: boolean
  /** 一次列出几位；`paged` 时固定 20（与翻页控件一致）。 */
  limit?: number
  /** 给翻页控件，浏览全部；否则只列前 `limit` 位，多了提示输入更完整的关键字。 */
  paged?: boolean
  /** 第一项给「散客」（选它即不关联账户）。 */
  guest?: boolean
  /** 页面的定时刷新间隔：结果跟着静默重读（实时事件到达时本来就会重读）。 */
  refetchInterval?: number | false
  /** 查询键里的资源名，和 `load` 对应：默认找账户，会员列表传 'loyalty-members'。 */
  resource?: string
  load?: (keyword: string, page: number, pageSize: number) => Promise<Page<AccountChoice>>
  hint?: string
  empty?: string
  /** 给「扫会员码」按钮（员工会员页、结账页选顾客）。 */
  scan?: boolean
  /** 扫会员码并查人（测试换替身）。 */
  scanCode?: () => Promise<MemberScan>
  inputAction?: ReactNode
  showResults?: boolean
  placeholder?: string
}) {
  const [page, setPage] = useState(1)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  const scanMember = async () => {
    if (scanning) return
    setScanning(true)
    setScanError('')
    try {
      const outcome = await scanCode()
      if (outcome.kind === 'found') {
        const { id, nickname, phoneMasked } = outcome.account
        onSelect({ id, nickname, ...(phoneMasked ? { phoneMasked } : {}) })
      } else if (outcome.kind === 'error') setScanError(outcome.message)
    } finally {
      setScanning(false)
    }
  }
  const size = paged ? 20 : limit
  const result = useServerSearch([resource, size], (value, current) => load(value, current, size), keyword, {
    page: paged ? page : 1,
    refetchInterval,
    enabled: showResults,
  })
  const typed = !!keyword.trim()
  const pinned = selected && !result.items.some((account) => account.id === selected.id) ? selected : null
  const option = (active: boolean) => `staff-account-option ${active ? 'staff-account-option-selected' : ''}`
  const row = (account: AccountChoice) => (
    <Button
      key={account.id}
      className={option(selected?.id === account.id)}
      ariaLabel={`${accountText(account)}${selected?.id === account.id ? '，已选中' : ''}`}
      disabled={disabled}
      onClick={() => onSelect(account)}
    >
      <View className="grow">
        <Text>{nameOf(account)}</Text>
        {account.unclaimed && <Text className="field-help">店员代开 · 未认领</Text>}
      </View>
      <Text className="muted">{phoneOf(account)}</Text>
    </Button>
  )
  return (
    <View className="staff-account-search">
      {scan && (
        <View className="staff-account-scan">
          <ActionButton
            variant="outline"
            loading={scanning}
            loadingText="正在查找顾客"
            disabled={disabled}
            onClick={() => void scanMember()}
          >
            扫会员码
          </ActionButton>
          {scanError ? (
            <View className="field-error" role="alert">
              {scanError}
            </View>
          ) : (
            <Text className="field-help">顾客打开小程序「我的 › {membershipName}」亮出会员码，扫一下直接选中。</Text>
          )}
        </View>
      )}
      <View className={inputAction ? 'staff-account-input-row' : ''}>
        <Field
          label={label}
          value={keyword}
          onChange={(value) => {
            setPage(1)
            onKeyword(value)
          }}
          placeholder={placeholder}
          disabled={disabled}
        />
        {inputAction}
      </View>
      {showResults && (
        <>
          <View className="staff-account-list">
            {guest && (
              <Button
                className={option(!selected)}
                ariaLabel={`散客，不关联账户${selected ? '' : '，已选中'}`}
                disabled={disabled}
                onClick={() => onSelect(null)}
              >
                <Text className="grow">散客</Text>
                <Text className="muted">不关联账户</Text>
              </Button>
            )}
            {pinned && row(pinned)}
            {result.items.map(row)}
          </View>
          {result.loading && <Text className="field-help">正在查找…</Text>}
          {!!result.error && (
            <View className="staff-notice" role="alert">
              <Text>
                {result.ready ? `刷新失败，显示的是上次的结果：${result.error}` : `查找失败：${result.error}`}
              </Text>
              <Button className="text-button" disabled={disabled} onClick={result.retry}>
                重试
              </Button>
            </View>
          )}
          {result.ready && !result.loading && result.items.length === 0 && (
            <Text className="field-help">{typed ? empty : '还没有注册的顾客。'}</Text>
          )}
          {result.ready && !typed && result.items.length > 0 && <Text className="field-help">{hint}</Text>}
          {!paged && result.total > result.items.length && (
            <Text className="field-help">
              共 {result.total} 位，只列出前 {result.items.length} 位；请输入更完整的昵称或手机号。
            </Text>
          )}
          {paged && (
            <PageControls
              page={result.page - 1}
              total={result.total}
              onChange={(next) => setPage(next + 1)}
              disabled={disabled}
            />
          )}
        </>
      )}
    </View>
  )
}
