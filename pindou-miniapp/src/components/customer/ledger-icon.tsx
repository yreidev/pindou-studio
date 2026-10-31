import { View } from '@tarojs/components'
import { DesignIcon } from './design-icon'
import './ledger-icon.scss'

export function LedgerIcon({ kind = 'other' }: { kind?: string }) {
  return (
    <View className={`ledger-icon ledger-icon-${kind}`} aria-hidden>
      <DesignIcon name={kind === 'other' ? 'recharge' : kind} />
    </View>
  )
}
