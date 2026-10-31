import Taro from '@tarojs/taro'
import { customer } from './platform'
import { errorMessage, type DeveloperMode } from './customer'
import { confirmLeave } from './navigation'

export type ExperienceRole = Exclude<DeveloperMode, 'developer'>
export const experienceRoles: ExperienceRole[] = ['guest', 'customer', 'clerk', 'manager', 'owner']
export const developerModeNames: Record<DeveloperMode, string> = {
  developer: '未选择',
  guest: '游客',
  customer: '顾客',
  clerk: '店员',
  manager: '店长',
  owner: '老板',
}
let switching = false

export async function switchExperienceRole(selected?: ExperienceRole) {
  if (switching) return
  const original = customer.getSnapshot()
  if (!original.account?.developerMode) return
  switching = true
  let loading = false
  let notice = ''
  try {
    let role = selected
    if (!role) {
      try {
        const choice = await Taro.showActionSheet({
          itemList: experienceRoles.map(
            (value) => `${developerModeNames[value]}${value === original.account?.developerMode ? '（当前）' : ''}`,
          ),
        })
        role = experienceRoles[choice.tapIndex]
      } catch {
        return
      }
    }
    if (!role || !experienceRoles.includes(role) || role === original.account.developerMode) return
    if (!(await confirmLeave())) return
    const latest = customer.getSnapshot()
    if (
      latest.revision !== original.revision ||
      latest.account?.id !== original.account.id ||
      latest.account?.developerMode !== original.account.developerMode
    )
      return
    await Taro.showLoading({ title: '正在切换', mask: true })
    loading = true
    await customer.switchDeveloperMode(role)
    const url =
      role === 'guest'
        ? '/pages/index/index'
        : role === 'customer'
          ? '/pages/profile/index'
          : '/pages/staff/workbench/index'
    try {
      await Taro.reLaunch({ url })
    } catch {
      notice = '身份已切换，请重新打开首页'
    }
  } catch (error) {
    notice = errorMessage(error)
  } finally {
    if (loading) Taro.hideLoading()
    switching = false
  }
  if (notice) void Taro.showToast({ title: notice, icon: 'none' })
}
