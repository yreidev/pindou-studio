import Taro from '@tarojs/taro'

/**
 * 桌码：扫出来的值 → 桌位 ID。
 *
 * 顾客到店的第一个动作就是扫桌码，所以这段要能被**两处**调用：首页那张「本次手作」主卡
 * （扫完直接带着桌位进页面），和手作页里的「重新扫描」。放在页面里就只有后者能用，
 * 首页只好先跳一个空页让人再点一次按钮。
 */

/** 小程序码的 scene 是 32 位无连字符 UUID，补回连字符才能和后端的 ID 对上。 */
export const withDashes = (value: string) => value.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')

/** 从二维码里认桌位 ID。认不出返回空串 —— 扫到的可能是别家的码。 */
export function tableIdFrom(value: string): string {
  const match = value.match(/(?:tableId=|examplebrand-table:)([a-f0-9-]{36})/i) || value.match(/scene=([a-f0-9]{32})/i)
  if (!match) return ''
  return match[1].length === 32 ? withDashes(match[1]) : match[1]
}

/**
 * 页面启动参数里的桌位：站内跳转带的 tableId；微信扫小程序码时的 scene（32 位无连字符）；
 * 微信「扫普通链接二维码打开小程序」时，扫到的网页桌码地址（https://pindou.example.invalid/t?tableId=…）编码后放在 q 里。
 * 都没有返回空串。
 */
export function tableIdFromLaunch(params: Partial<Record<string, string>>): string {
  if (params.tableId) return params.tableId
  if (params.scene && /^[a-f0-9]{32}$/i.test(params.scene)) return withDashes(params.scene)
  if (!params.q) return ''
  // 微信要页面自己解一次码；框架已经解过时再解一次也不变（地址里只有桌位编号，没有 %）
  try {
    return tableIdFrom(decodeURIComponent(params.q))
  } catch {
    return ''
  }
}

/** 用户自己取消扫码不是错误，不该弹提示。 */
export const scanCancelled = (error: unknown) => String((error as { errMsg?: string })?.errMsg || '').includes('cancel')

/**
 * 打开相机扫桌码。
 * - 成功：返回桌位 ID
 * - 用户取消：返回 ''
 * - 扫到不认识的码 / 相机打不开：抛错，由调用方决定怎么显示
 */
export async function scanTableCode(): Promise<string> {
  let result: { path?: string; result?: string }
  try {
    result = await Taro.scanCode({ onlyFromCamera: true })
  } catch (error) {
    if (scanCancelled(error)) return ''
    throw error
  }
  const id = tableIdFrom(result.path || result.result || '')
  if (!id) throw new Error('请扫描门店桌码')
  return id
}
