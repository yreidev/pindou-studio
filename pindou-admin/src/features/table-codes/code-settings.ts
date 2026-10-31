import { ApiError } from '../../api/client'
import type { MiniProgramEnv } from '../../api/table-codes'
import { readableError } from '../operations/messages'

// 小程序码指向的版本（后端迁移 023，接口 /system/code-settings）：桌码（小程序码）和网页后台登录页的小程序码
// 都按它生成。只有老板能改；改错了顾客扫不开桌码、员工登录不了网页后台，所以页面上默认只读，
// 改的时候要看完提醒、写原因、勾选确认，后端还会先用新版本试生成一次，微信不收就不保存。

export interface EnvOption {
  value: MiniProgramEnv
  label: string
  /** 谁能打开、什么时候用。 */
  detail: string
  /** 标签颜色：正式版绿、体验版橙、开发版红。 */
  color: 'green' | 'orange' | 'red'
}

export const envOptions: EnvOption[] = [
  {
    value: 'release',
    label: '正式版',
    detail: '所有人都能打开。要等小程序正式版审核通过、发布之后才能用；没发布前选它，保存时微信会拒绝。',
    color: 'green',
  },
  {
    value: 'trial',
    label: '体验版',
    detail: '只有公众平台登记的体验成员能打开。正式版发布之前用它（没改过时就是它）。',
    color: 'orange',
  },
  {
    value: 'develop',
    label: '开发版',
    detail: '只有小程序的开发者能打开，店员和顾客都扫不开。只在开发调试时临时用，用完改回来。',
    color: 'red',
  },
]

export const envOption = (env: MiniProgramEnv): EnvOption =>
  envOptions.find((option) => option.value === env) ?? envOptions[1]

/** 修改前必须看到的后果。 */
export const changeWarnings = [
  '之后新生成的小程序桌码，顾客扫了打开的是这里选的版本：那个版本顾客打不开，就进不了入座页。',
  '网页后台登录页的小程序码也按这个版本生成：选错了，员工用微信扫码打不开批准页，就登录不了网页后台（已经登录的不受影响，可以在这里改回来）。',
  '网页桌码（普通二维码）由公众平台「扫普通链接二维码打开小程序」的规则打开小程序，不受这个设置影响。',
]

export const maxReasonLength = 200

export interface ChangeDraft {
  current: MiniProgramEnv
  target: MiniProgramEnv
  reason: string
  /** 勾了「我知道改错的后果」。 */
  acknowledged: boolean
}

/** 能不能提交：换了版本、写了原因（不超过 200 字）、勾了确认。 */
export function canSubmit(draft: ChangeDraft): boolean {
  const reason = draft.reason.trim()
  return (
    draft.target !== draft.current && reason.length > 0 && [...reason].length <= maxReasonLength && draft.acknowledged
  )
}

/** 提交按钮旁边说明还差什么。 */
export function missingStep(draft: ChangeDraft): string | null {
  if (draft.target === draft.current) return '先选一个和现在不同的版本'
  if (!draft.reason.trim()) return '写明为什么改'
  if ([...draft.reason.trim()].length > maxReasonLength) return `原因最多 ${maxReasonLength} 字`
  if (!draft.acknowledged) return '勾选确认已了解后果'
  return null
}

/** 保存失败的说明：版本被别人改过要重新确认；微信拒绝时带着微信的原因（后端已写成中文）。 */
export function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return '只有老板可以修改小程序码指向的版本。'
    if (error.code === 'code_settings_conflict') return `${error.message}。已重新读取，请看清现在的版本后再决定。`
  }
  return readableError(error, '保存失败，没有修改，请稍后重试')
}
