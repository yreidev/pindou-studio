// 会员资产写操作失败时给人看的说明。后端的业务错误本身就是中文，原样显示；
// 只有权限不足在鉴权那一步回的是英文 forbidden，换成中文。

export function actionErrorMessage(error: unknown): string {
  const { status, message } = (error ?? {}) as { status?: number; message?: string }
  if (status === 403) return '当前账号无权办理：充值退款只有老板能办理。'
  return message || '操作失败，请稍后重试'
}

/**
 * 柜台三项（充值登记、积分兑换、生日礼物核销，所有员工都能办）失败时的说明：后端的中文原样显示
 * （余额积分不足、兑换次数已达上限、库存不足、规则或资产已变化……）；无权、不存在已由接口客户端换成中文。
 */
export function counterErrorMessage(error: unknown): string {
  const { message } = (error ?? {}) as { message?: string }
  return message || '操作失败，请稍后重试'
}

/**
 * 409：会员资产已变化（版本不符）、余额或积分不足、这笔充值已退过等。
 * 都要重新读取最新资产，核对后再由人确认，不自动换版本重提。
 * 「上次已生效」（previous_applied，见 api/client.ts）虽也是 409，但不是冲突，是提醒，不算在内。
 */
export function isConflict(error: unknown): boolean {
  const { status, code } = (error ?? {}) as { status?: number; code?: string }
  return status === 409 && code !== 'previous_applied'
}
