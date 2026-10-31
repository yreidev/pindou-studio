// 微信原生组件的颜色参数（showModal 的 confirmColor、Checkbox 的 color）只接受
// 字面色值，读不到 WXSS 变量，所以这里镜像 styles/_tokens.scss 的对应 token。
// 改 _tokens.scss 时必须同步这里——两边没有自动校验。
export const nativeColors = {
  action: '#806539', // $action
  surface: '#ffffff', // $surface
  danger: '#a82929', // $danger
} as const
