import { useLayoutEffect, useRef } from 'react'

/**
 * 侧边抽屉（Semi SideSheet）的焦点。Semi 的 Modal 有焦点陷阱、关闭时还焦点，SideSheet 没有：抽屉只是 role=dialog、
 * tabIndex=-1 的 div，打开后焦点还留在页面上点的那个按钮上，Tab 会走到后面的页面，关了也不回来。这里补上：
 * - 打开时记下当时的焦点（点的座位、提醒行）；页面主体（#root）设为 inert，Tab 出不了抽屉、读屏也不念后面的页面
 *   （抽屉、下拉、弹窗、提示都挂在 body 上，不受影响）；
 * - 打开动画结束后把焦点放进抽屉，并给抽屉起读屏名（Semi 不给 dialog 起名）；
 * - 关闭动画结束后把焦点还给打开它的那个元素。
 *
 * 用法：SideSheet 带上 className，把返回的函数交给 afterVisibleChange。
 */
export function useSheetFocus(visible: boolean, { className, label }: { className: string; label: string }) {
  const opener = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    if (!visible) return
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    return () => root?.removeAttribute('inert')
  }, [visible])

  return (shown: boolean) => {
    if (shown) {
      const dialog = document.querySelector<HTMLElement>(`.${className} .semi-sidesheet-inner`)
      if (!dialog) return
      // 在把焦点移进抽屉之前记下当时的焦点（SideSheet 在打开的同一次提交里就回调这里，早于外层组件的 effect）
      const active = document.activeElement
      if (active instanceof HTMLElement && active !== document.body && !dialog.contains(active)) opener.current = active
      dialog.setAttribute('aria-label', label)
      if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true })
      return
    }
    const target = opener.current
    opener.current = null
    if (target?.isConnected) target.focus({ preventScroll: true })
  }
}
