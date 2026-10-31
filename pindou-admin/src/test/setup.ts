import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'

// findBy* / waitFor 默认只等 1 秒，CI 机器忙时不够，放宽到 5 秒。只是上限，正常时照样一到就往下走，不拖慢测试。
configure({ asyncUtilTimeout: 5000 })

// jsdom 不跑 CSS 动画，也就不会发 animationend。Semi 的弹层、抽屉、对话框收起时要等这个事件：下拉框收起后才回调
// afterClose，受控下拉框的 onChange 又在那之后。弹层定位算完之前 Semi 不开动画、直接收起，所以机器空闲时测试照过；
// 机器一忙定位先算完、动画开了，就永远等不到结束——「选顾客」那条测试在 CI 连挂、本机满负荷下 18 次挂 12 次就是这个
// （2026-10-06）。这里在元素换上 Semi 的动画类名时补发 animationend，等于动画立即放完；真浏览器里动画照常，端到端测试覆盖。
const semiAnimation = /-(?:animation|animate)-[\w-]*(?:show|hide)|-expandedIcon-(?:show|hide)|-icon-rotate-\d+/
const finishAnimation = (element: Element) => {
  if (semiAnimation.test(element.getAttribute('class') ?? ''))
    setTimeout(() => {
      // jsdom 没有 AnimationEvent，React 于是改听带前缀的 webkitAnimationEnd；两个名字都发，哪边听都收得到
      element.dispatchEvent(new Event('animationend', { bubbles: true }))
      element.dispatchEvent(new Event('webkitAnimationEnd', { bubbles: true }))
    })
}
new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === 'attributes') finishAnimation(record.target as Element)
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue
      finishAnimation(node)
      node.querySelectorAll('[class]').forEach(finishAnimation)
    }
  }
}).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })

// jsdom 缺 Semi 组件依赖的几个浏览器接口，补成最小可用实现。
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}
// Semi 的总入口带着 lottie-web，它一加载就在画布上画一个点；jsdom 没有画布，给一个什么都不画的
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillRect: () => {},
  })) as unknown as HTMLCanvasElement['getContext']
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})
