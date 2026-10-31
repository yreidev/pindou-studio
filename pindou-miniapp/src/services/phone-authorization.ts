type PhoneAuthorization = { code: string; message: string }

// ★ 这里原本有个构建期开关 TARO_APP_WECHAT_PHONE_AUTH，用来决定要不要显示
//   「获取微信手机号」按钮。删了，因为它管的是一件一辈子不变的事（这个小程序的主体
//   有没有手机号快速验证能力），却要改配置 + 重新构建上传才能翻 —— 代价全在维护侧。
//   事实也证明了：它一直是 0，没人记得，功能做完了却验不了。
//   而它想防的事，下面这个函数本来就防住了：主体没这个能力时微信回
//   「no permission / no authorization」，这里翻译成「请手动填写」并自动切回手输。
//   让它在第一次点击时自己暴露，比让人去记一个开关可靠。

export function phoneAuthorizationResult(detail: unknown): PhoneAuthorization {
  const value = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : {}
  const error = typeof value.errMsg === 'string' ? value.errMsg.toLowerCase() : ''
  const numericCode = [value.errno, value.errCode].find(
    (item): item is number | string =>
      (typeof item === 'number' || typeof item === 'string') && /^-?\d{1,9}$/.test(String(item)) && Number(item) !== 0,
  )
  if (typeof value.code === 'string' && value.code.trim() && !error.includes('fail') && numericCode === undefined) {
    return { code: value.code, message: '' }
  }
  // Never expose the raw event: it may contain phone codes or encrypted identity data.
  const reference = numericCode === undefined ? '' : `（错误码 ${numericCode}）`
  // 这些话显示在登录、创建账号和编辑资料页上，不写「微信」（2026-10-28 提审被驳回，见 pages/register/index.tsx）
  if (/privacy/.test(error)) {
    return { code: '', message: `隐私授权未完成，请重试或手动填写${reference}` }
  }
  if (/no permission|permission denied|no authorization/.test(error)) {
    return { code: '', message: `当前小程序暂无法快捷填写手机号，请手动填写${reference}` }
  }
  if (/user deny|user cancel|user denied|cancel/.test(error)) return { code: '', message: '' }
  if (/network|timeout|timed out/.test(error)) {
    return { code: '', message: `获取手机号时连接失败，请重试或手动填写${reference}` }
  }
  return { code: '', message: `没有拿到手机号，请重试或手动填写${reference}` }
}
