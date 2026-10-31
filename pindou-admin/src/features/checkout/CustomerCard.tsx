import { Banner, Button, Card, Typography } from '@douyinfe/semi-ui'
import type { Order } from '../../api/orders'
import type { ListedAccount } from '../../api/staff'
import { CustomerPicker } from '../../components/CustomerPicker'
import { customerLabel } from '../orders/orders'
import { canConfirmChoice, packageCustomerNote } from './customer'
import { confirmDialog } from '../../components/confirm'

/**
 * 顾客账户：现在绑的是谁（或散客），以及绑定、更换、改为散客。选人、提交、冲突的状态由结账页管
 * （离开保护要知道有没有选了还没确认的人；版本冲突后保留选好的人，重新读取后再确认）。
 */
export function CustomerCard({
  order,
  packageOrder,
  editing,
  choice,
  blocker,
  disabled,
  saving,
  error,
  errorType = 'danger',
  onEdit,
  onChoice,
  onCancel,
  onSubmit,
}: {
  order: Order
  packageOrder: boolean
  editing: boolean
  choice: ListedAccount | null
  /** 现在为什么不能换（customerChangeBlocker），能换为空串。 */
  blocker: string
  /** 页面上有别的请求在提交。 */
  disabled: boolean
  saving: boolean
  error: string | null
  /** 「上一次其实已经生效」这类不是失败的说明用 warning。 */
  errorType?: 'danger' | 'warning'
  onEdit: () => void
  onChoice: (account: ListedAccount | null) => void
  onCancel: () => void
  /** 提交：账户编号，或 null 改成散客。 */
  onSubmit: (accountId: string | null) => void
}) {
  const bound = Boolean(order.accountId)
  const askClear = () =>
    void confirmDialog({
      title: '改为散客',
      content: `订单将不再关联「${customerLabel(order)}」，结账时不能用会员余额和积分，直接登记线下收款。`,
      okText: '改为散客',
      // 和触发它的按钮一样标成危险操作（同看板、员工页的确认框）
      okType: 'danger',
    }).then((ok) => {
      if (ok) onSubmit(null)
    })
  return (
    <Card title="顾客账户">
      <div className="checkout-customer">
        <Typography.Text strong>{customerLabel(order)}</Typography.Text>
        <Typography.Text type="tertiary" size="small" className="field-help">
          {packageOrder
            ? packageCustomerNote
            : bound
              ? '已绑定顾客账户，走会员结账：可用余额和积分。'
              : '散客单：没有绑定顾客账户，不能用会员余额和积分。要用会员结账，先绑定顾客账户。'}
        </Typography.Text>
      </div>
      {packageOrder ? null : editing ? (
        <div className="checkout-customer-edit">
          <CustomerPicker label="选择顾客账户" value={choice} onChange={onChoice} disabled={disabled || saving} />
          {bound ? (
            <Typography.Text type="tertiary" size="small" className="field-help">
              换了顾客，会员优惠按新顾客重新计算。
            </Typography.Text>
          ) : null}
          <div className="checkout-actions">
            <Button
              theme="solid"
              type="primary"
              loading={saving}
              disabled={disabled || Boolean(blocker) || !canConfirmChoice(order, choice)}
              onClick={() => choice && onSubmit(choice.id)}
            >
              {bound ? '确认更换' : '确认绑定'}
            </Button>
            <Button disabled={saving} onClick={onCancel}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <div className="checkout-actions">
          <Button disabled={disabled || Boolean(blocker)} onClick={onEdit}>
            {bound ? '更换顾客' : '绑定顾客账户'}
          </Button>
          {bound ? (
            <Button type="danger" loading={saving} disabled={disabled || Boolean(blocker)} onClick={askClear}>
              改为散客
            </Button>
          ) : null}
        </div>
      )}
      {!packageOrder && blocker ? (
        <Typography.Text type="tertiary" size="small" className="field-help">
          {blocker}
        </Typography.Text>
      ) : null}
      {error ? <Banner type={errorType} closeIcon={null} style={{ marginTop: 12 }} description={error} /> : null}
    </Card>
  )
}
