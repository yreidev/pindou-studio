import { Select, Typography } from '@douyinfe/semi-ui'
import { useDebouncedValue } from '@tanstack/react-pacer'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { accountSearchQuery, type ListedAccount } from '../../api/staff'
import { accountLabel, assignableAccounts, currentRoles } from './roles'

/** 下拉里一次列出的账号数；更多的靠关键字在服务端筛。 */
export const pickerPageSize = 20

/**
 * 选员工账号：关键字在服务端筛（GET /accounts?q=…&pageSize=20），不把全部账号拉到页面上。
 * 没输入时列出最新注册的一批（新员工通常刚注册）；输入停下 300 毫秒才发请求。
 * 下拉第一次打开才开始读，选中的账号对象交给调用方，确认弹窗直接用它。
 */
export function AccountPicker({
  value,
  onChange,
  isOwner,
  invalid,
}: {
  value: ListedAccount | null
  onChange: (account: ListedAccount | null) => void
  /** 店长看不到、也分配不了老板 */
  isOwner: boolean
  invalid: boolean
}) {
  const [keyword, setKeyword] = useState('')
  const [opened, setOpened] = useState(false)
  const [q] = useDebouncedValue(keyword.trim(), { wait: 300 })
  const accounts = useQuery({
    ...accountSearchQuery({ q: q || undefined, page: 1, pageSize: pickerPageSize }),
    enabled: opened,
  })
  const found = accounts.data?.rows ?? []
  const candidates = assignableAccounts(found, isOwner)
  const more = (accounts.data?.total ?? 0) - found.length

  return (
    <Select
      style={{ width: '100%', marginTop: 8 }}
      filter
      // 服务端已经按关键字筛过，不再按选项文字二次过滤
      remote
      onSearch={(input: string) => setKeyword(input)}
      onDropdownVisibleChange={(visible) => {
        if (visible) setOpened(true)
      }}
      // 候选项分两行（label 传 ReactNode），手机上不会撑出屏幕；选中后的显示仍按一行文字
      renderSelectedItem={(option: Record<string, unknown>) => String(option.text ?? '')}
      placeholder="搜昵称、手机尾号或账号编号"
      // 换了关键字、新一批还没回来时转圈，别让人点到上一批
      loading={opened && (accounts.isPending || accounts.isPlaceholderData)}
      value={value?.id}
      onChange={(id) => onChange(candidates.find((account) => account.id === id) ?? null)}
      optionList={candidates.map((account) => ({
        value: account.id,
        label: (
          <div>
            <div>{account.nickname}</div>
            <Typography.Text type="tertiary" size="small">
              {account.phoneMasked || account.id.slice(0, 8)} · 当前 {currentRoles(account)}
            </Typography.Text>
          </div>
        ),
        text: accountLabel(account),
      }))}
      emptyContent={accounts.isError ? accounts.error.message : q ? '没有匹配的账号' : '还没有注册的账号'}
      outerBottomSlot={
        more > 0 ? (
          <div style={{ padding: '8px 12px' }}>
            <Typography.Text type="tertiary" size="small">
              {q
                ? `还有 ${more} 个匹配的账号没列出，请输入更完整的关键字`
                : `只列出最新注册的 ${found.length} 个，其他账号请输入关键字查找`}
            </Typography.Text>
          </div>
        ) : null
      }
      validateStatus={invalid ? 'error' : 'default'}
    />
  )
}
