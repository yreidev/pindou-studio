import { Text, View } from '@tarojs/components'
import { Button } from '../button'
import { PageControls, pageSlice } from '../pagination'
import { LedgerIcon } from './ledger-icon'
import { entryMonths, memberDay } from '../../services/member-entry'
import { moneyText } from '../../services/format'
import { navigateApp } from '../../services/navigation'
import type { Entry } from '../../services/membership'

export function MemberHistory({
  entries,
  page,
  onPage,
  busy,
}: {
  entries: Entry[]
  page: number
  onPage: (page: number) => void
  busy: boolean
}) {
  const groups = entryMonths(entries)
  const rows = groups.flatMap((group) => group.rows)
  const visible = new Set(pageSlice(rows, page).map((row) => row.entry.id))
  return (
    <View className="member-history">
      {groups.map((group) => {
        const shown = group.rows.filter((row) => visible.has(row.entry.id))
        if (!shown.length) return null
        return (
          <View className="member-month" key={group.key}>
            <View className="member-month-head">
              <Text className="member-month-title">{group.label}</Text>
              <Text className="member-month-total">
                消费 ¥{moneyText(group.consumption)} · 充值 ¥{moneyText(group.recharge)}
              </Text>
            </View>
            <View className="member-history-list">
              {shown.map((row) => (
                <Button
                  key={row.entry.id}
                  className={`member-history-row ${row.reversal ? 'member-history-reversed' : ''}`}
                  disabled={busy}
                  onClick={() =>
                    void navigateApp(`/pages/customer/consumption-detail/index?id=${encodeURIComponent(row.entry.id)}`)
                  }
                >
                  <LedgerIcon kind={row.reversal ? 'reversed-consume' : row.icon} />
                  <View className="member-history-copy">
                    <Text className="member-history-title">{row.title}</Text>
                    <Text className="member-history-note">
                      {memberDay(row.date)}
                      {row.notes[0] && !row.reversal ? ` · ${row.notes[0]}` : ''}
                      {(row.reversal ? row.notes.filter((line) => line.startsWith('门店撤销')) : row.notes.slice(1))
                        .map((line) => `\n${line}`)
                        .join('')}
                    </Text>
                  </View>
                  <View className="member-history-value">
                    <Text
                      className={`member-history-amount ${row.entry.kind === 'recharge' ? 'member-history-positive' : ''}`}
                    >
                      {row.amount}
                    </Text>
                    {row.reversal ? (
                      <Text className="member-history-reversal">已撤销 · 已退回</Text>
                    ) : (
                      !!row.balance && <Text className="member-history-note">{row.balance}</Text>
                    )}
                  </View>
                </Button>
              ))}
            </View>
          </View>
        )
      })}
      <PageControls page={page} total={rows.length} onChange={onPage} disabled={busy} />
      {rows.length > 0 && (page + 1) * 20 >= rows.length && (
        <Text className="member-history-end">没有更早的记录了</Text>
      )}
    </View>
  )
}
