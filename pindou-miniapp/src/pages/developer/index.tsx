import { useState } from 'react'
import { Picker, Text, View } from '@tarojs/components'
import { Button } from '../../components/button'
import { Screen, Skeleton, Status } from '../../components/customer'
import {
  developerModeNames,
  experienceRoles,
  switchExperienceRole,
  type ExperienceRole,
} from '../../services/developer-switch'
import { useCustomer } from '../../hooks/customer'
import './index.scss'

const modes = experienceRoles
export default function DeveloperWorkbench() {
  const auth = useCustomer()
  const current = auth.account?.developerMode
  const [selected, setSelected] = useState<ExperienceRole>(current && current !== 'developer' ? current : 'customer')
  return (
    <Screen title="身份切换" back className="developer-screen">
      {auth.status === 'loading' ? (
        <Skeleton />
      ) : !current ? (
        <Status kind="forbidden" title="暂无开发者权限" message="当前账号未获开发者授权。" />
      ) : (
        <>
          <View className="developer-account">
            <Text className="developer-name">{auth.account?.nickname}</Text>
            <Text className="muted">当前身份：{developerModeNames[current]}</Text>
          </View>
          <View className="developer-switch">
            <Text className="field-label">切换身份</Text>
            <Picker
              range={modes.map((mode) => developerModeNames[mode])}
              value={modes.indexOf(selected)}
              onChange={(event) => setSelected(modes[Number(event.detail.value)])}
            >
              <View className="developer-picker" ariaLabel={`目标身份：${developerModeNames[selected]}`}>
                {developerModeNames[selected]}
              </View>
            </Picker>
            <Text className="developer-write-notice">业务操作会真实保存，并记入当前账号的审计记录。</Text>
            <Button
              className="button button-primary"
              disabled={selected === current}
              onClick={() => {
                void switchExperienceRole(selected)
              }}
            >
              {selected === current
                ? '当前身份'
                : `进入${developerModeNames[selected]}${['clerk', 'manager', 'owner'].includes(selected) ? '工作台' : '页面'}`}
            </Button>
          </View>
        </>
      )}
    </Screen>
  )
}
