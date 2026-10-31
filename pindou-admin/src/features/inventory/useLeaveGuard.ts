import { useBlocker } from '@tanstack/react-router'
import { confirmDialog } from '../../components/confirm'

/** 问一句要不要放弃没保存的输入；放弃返回 true，继续填写返回 false。 */
export function askDiscard(): Promise<boolean> {
  return confirmDialog({
    title: '放弃未保存的输入？',
    content: '刚才填写的内容还没提交，离开后不会保留。',
    okText: '放弃并离开',
    cancelText: '继续填写',
    // 会丢掉输入：确认按钮用危险样式
    okType: 'danger',
  })
}

const tabOf = (search: unknown) => (search as { tab?: string } | undefined)?.tab ?? 'stock'

/**
 * 有没提交的输入时，切换标签页、点侧栏去别的页面、浏览器后退都先确认；关闭或刷新浏览器标签页由浏览器提示。
 * 同一标签页里改网址参数（翻页、筛选）不拦；去登录页（退出、登录失效）也不拦——会话已经没了，留下也提交不了。
 */
export function useLeaveGuard(dirty: boolean): void {
  useBlocker({
    disabled: !dirty,
    enableBeforeUnload: dirty,
    shouldBlockFn: async ({ current, next }) => {
      if (next.pathname === '/login') return false
      if (current.pathname === next.pathname && tabOf(current.search) === tabOf(next.search)) return false
      return !(await askDiscard())
    },
  })
}
