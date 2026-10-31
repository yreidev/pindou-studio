import { Banner, Button, Card, Descriptions, Input, Spin, Switch, Tag, Typography } from '@douyinfe/semi-ui'
import type { UseQueryResult } from '@tanstack/react-query'
import type { LoyaltyQuote } from '../../api/checkout'
import type { LoyaltyMember } from '../../api/members'
import type { Order } from '../../api/orders'
import { Field } from '../../components/Field'
import { money } from '../../lib/format'
import { discountLabel } from '../members/members'
import { customerLabel } from '../orders/orders'
import { quoteRows } from './member'

/**
 * 会员结账：订单开单时绑定的顾客直接带出。打开页面就按「不用积分、不用余额」先算一份报价，
 * 什么都不动也能直接收线下款；要抵扣才动积分和余额，改了就重算。金额全部来自报价接口。
 */
export function MemberCard({
  order,
  member,
  points,
  onPoints,
  pointsError,
  useBalance,
  onUseBalance,
  balance: balanceText,
  onBalance,
  balanceError,
  quote,
  quoteError,
  onRequote,
  linesDirty,
  disabled,
}: {
  order: Order
  member: UseQueryResult<LoyaltyMember>
  points: string
  onPoints: (value: string) => void
  pointsError: string | null
  useBalance: boolean
  onUseBalance: (value: boolean) => void
  /** 这次用多少储值（元）：空着就是能用多少用多少；会员只用储值付自己那份时填。 */
  balance: string
  onBalance: (value: string) => void
  balanceError: string | null
  quote: UseQueryResult<LoyaltyQuote>
  /** 报价失败的原因（积分不够整份、超过上限等，后端给的中文说明）。 */
  quoteError: string | null
  onRequote: () => void
  linesDirty: boolean
  disabled: boolean
}) {
  const balance = member.data?.balance
  return (
    <Card
      title={
        // 和别的卡片标题一样用 6 级标题（标题传节点时 Semi 不再套标题样式）
        <span className="checkout-card-title">
          <Typography.Title heading={6} style={{ margin: 0 }}>
            会员结账
          </Typography.Title>
          <Tag color="violet">{customerLabel(order)}</Tag>
        </span>
      }
    >
      {balance ? (
        // size 只在 row 布局（数据概览）下起作用，这里是左对齐的键值表，不写
        <Descriptions
          className="checkout-balance"
          align="left"
          data={[
            {
              key: '会员等级',
              value: `${balance.tierName || '普通会员'}（${discountLabel(balance.rateBasisPoints)}）`,
            },
            { key: '储值本金', value: money(balance.principalCents) },
            { key: '赠送余额', value: money(balance.giftCents) },
            { key: '可用积分', value: `${balance.points.toLocaleString('zh-CN')} 积分` },
          ]}
          style={{ marginBottom: 12 }}
        />
      ) : member.isError ? (
        <Typography.Text type="danger" size="small" className="field-help">
          会员资产读取失败：{member.error.message}
        </Typography.Text>
      ) : (
        <Typography.Text type="tertiary" size="small" className="field-help">
          正在读取会员资产…
        </Typography.Text>
      )}

      <div className="checkout-member-inputs">
        <Field
          label="使用积分"
          help={pointsError ? null : '按积分抵扣规则整份使用，0 表示不用'}
          errors={pointsError ? [pointsError] : undefined}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              style={{ width: 160 }}
              disabled={disabled}
              value={points}
              onChange={onPoints}
            />
          )}
        </Field>
        <Field label="使用储值余额" help="先扣本金，再扣赠送余额">
          {(control) => (
            <Switch
              id={control.id}
              aria-describedby={control['aria-describedby']}
              checked={useBalance}
              disabled={disabled}
              onChange={onUseBalance}
            />
          )}
        </Field>
        {useBalance ? (
          // 多人合付时会员只用储值付自己那份：填这次用多少，空着照旧能用多少用多少。超了由后端说明（报价失败）
          <Field
            label="这次用多少储值（元）"
            help={balanceError ? null : '只付会员自己那份时填，不超过可用储值和这一笔应付；空着就能用多少用多少'}
            errors={balanceError ? [balanceError] : undefined}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                prefix="¥"
                placeholder="全部可用"
                style={{ width: 160 }}
                disabled={disabled}
                value={balanceText}
                onChange={onBalance}
              />
            )}
          </Field>
        ) : null}
      </div>

      {linesDirty ? (
        <Typography.Text type="warning" size="small" className="field-help">
          明细改过还没保存：下面是按已保存的明细算的，保存后自动重算。
        </Typography.Text>
      ) : null}
      {pointsError ? null : quoteError ? (
        <Banner
          type="warning"
          closeIcon={null}
          style={{ marginTop: 8 }}
          fullMode={false}
          title="会员优惠算不出来"
          description={
            <div>
              <div>{quoteError}</div>
              <Button
                size="small"
                style={{ marginTop: 8 }}
                loading={quote.isFetching}
                disabled={disabled}
                onClick={onRequote}
              >
                重新计算
              </Button>
            </div>
          }
        />
      ) : quote.data ? (
        <Spin spinning={quote.isFetching} tip="正在重新计算…">
          <Descriptions
            className="checkout-quote"
            align="left"
            data={quoteRows(quote.data).map((row) => ({
              key: row.label,
              value: row.strong ? <Typography.Text strong>{row.value}</Typography.Text> : row.value,
            }))}
            style={{ marginTop: 8 }}
          />
        </Spin>
      ) : (
        <Typography.Text type="tertiary" size="small" className="field-help">
          正在按当前明细计算会员优惠…
        </Typography.Text>
      )}
    </Card>
  )
}
