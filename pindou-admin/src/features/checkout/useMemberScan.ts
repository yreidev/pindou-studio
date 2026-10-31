import { Toast } from '@douyinfe/semi-ui'
import { useMutation } from '@tanstack/react-query'
import { asListedAccount, memberCodesApi } from '../../api/member-codes'
import type { ListedAccount } from '../../api/staff'
import { isMemberCode, useScanRelay } from '../../realtime/scans'

/**
 * 结账页接手机「扫码给电脑」转来的会员码（2026-10-06）：查出这位顾客、打开「顾客账户」并选好他，
 * 由员工核对后点「确认绑定 / 确认更换」——换顾客会改订单版本、作废会员报价，不替员工直接提交。
 * 现在不能换顾客（套餐单、已不是待结账、明细没保存、订单被改过）时只提示原因。商品条码不认领：结账页没有按条码加商品的入口。
 */
export function useMemberScan({
  enabled,
  blocker,
  current,
  onChoose,
}: {
  /** 待结账订单才认领。 */
  enabled: boolean
  /** 现在为什么不能换顾客（customerChangeBlocker），能换为空串。 */
  blocker: string
  /** 订单现在绑的顾客账户编号，散客为空。 */
  current: string | undefined
  onChoose: (account: ListedAccount) => void
}): void {
  const lookup = useMutation({
    mutationFn: memberCodesApi.lookup,
    onSuccess: (found) => {
      if (found.id === current) {
        Toast.info(`手机扫到的会员码就是这张单现在的顾客「${found.nickname}」`)
        return
      }
      onChoose(asListedAccount(found))
      Toast.success(`已按会员码选中「${found.nickname}」，核对后点${current ? '「确认更换」' : '「确认绑定」'}`)
    },
    onError: (error) => Toast.error(error.message),
  })
  useScanRelay(
    enabled
      ? (code) => {
          if (!isMemberCode(code)) return false
          if (blocker) Toast.warning(`手机扫到会员码，但现在不能换顾客：${blocker}`)
          else lookup.mutate(code.trim())
          return true
        }
      : null,
  )
}
