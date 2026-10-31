import { useEffect } from 'react'
import { Text, View } from '@tarojs/components'
import { SheetCloseButton, SheetFrame } from '../sheet'
import { usePageVisible } from '../../hooks/query'
import { brightenScreen } from '../../services/screen-brightness'
import { DesignIcon } from './design-icon'
import { MemberCodeCard } from './member-code'

export function MemberCodeSheet({ onClose }: { onClose: () => void }) {
  const visible = usePageVisible()
  useEffect(() => {
    if (visible) return brightenScreen()
  }, [visible])
  return (
    <SheetFrame
      mask="member-code-mask"
      panel="member-code-sheet"
      label="会员码"
      onClose={onClose}
      head={
        <View className="member-code-sheet-head">
          <Text className="member-code-sheet-title">会员码</Text>
          <SheetCloseButton className="member-code-close">
            <DesignIcon name="close" />
          </SheetCloseButton>
        </View>
      }
    >
      <MemberCodeCard sheet />
    </SheetFrame>
  )
}
