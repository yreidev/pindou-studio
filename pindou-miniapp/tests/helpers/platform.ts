// 测试里 @tarojs/taro 与 @tarojs/components 的默认替身。
//
// 真的 @tarojs/taro 要小程序运行时，Node 里装不起来；页面钩子（useDidShow 等）是构建时由 Taro 的
// React 插件接上的。所以每个测试文件默认拿到这里的替身（tests/setup.ts 注册），用例要观察某个调用时
// 再用 load() 或 vi.mock 换成自己的。

const noop = () => undefined

/** 默认的 Taro：没被用例替换的接口一律什么都不做、返回 undefined。 */
export function taroDefaults() {
  const api: Record<string, unknown> = new Proxy(
    {},
    { get: (_target, key) => (typeof key === 'string' && key !== 'then' ? noop : undefined) },
  )
  return {
    default: api,
    useDidShow: noop,
    useDidHide: noop,
    usePullDownRefresh: noop,
    useUnload: noop,
    useShareAppMessage: noop,
    useShareTimeline: noop,
    useRouter: () => ({ path: '', params: {} }),
  }
}

/** 默认的原生组件：渲染成以组件名为类型的元素，测试按名字找节点。 */
export const componentNames = [
  'Button',
  'Checkbox',
  'CheckboxGroup',
  'Image',
  'Input',
  'Label',
  'MovableArea',
  'MovableView',
  'Picker',
  'ScrollView',
  'Switch',
  'Text',
  'Textarea',
  'View',
] as const

export function componentDefaults() {
  return Object.fromEntries(componentNames.map((name) => [name, name]))
}
