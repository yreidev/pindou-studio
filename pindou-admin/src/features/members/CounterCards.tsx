import { Banner, Button, Card, Col, Radio, RadioGroup, Row, Table, Toast, Typography } from '@douyinfe/semi-ui'
import type { ColumnProps } from '@douyinfe/semi-ui/lib/es/table'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { hasRole, useCurrentAccount } from '../../account'
import { storeToday } from '../../lib/format'
import { ServiceDateField } from './ServiceDateField'
import { serviceDateError } from './consumption'
import { isPreviousApplied } from '../../api/client'
import {
  membersApi,
  type LoyaltyEntry,
  type LoyaltyMember,
  type LoyaltyRule,
  type OfflineMethod,
} from '../../api/members'
import { confirmDialog } from '../../components/confirm'
import { Field } from '../../components/Field'
import { Nowrap } from '../../components/Nowrap'
import { dateTime, money } from '../../lib/format'
import {
  defaultRechargeMethod,
  exchangeConfirmText,
  exchangeRules,
  giftConfirmText,
  pendingGifts,
  rechargeConfirmText,
  rechargeMethods,
  rechargeRules,
} from './counter'
import { methodName } from './entries'
import { counterErrorMessage, isConflict } from './errors'
import { registeredEntry } from './copy'
import { CopyMemberEntry } from './CopyMemberEntry'

// 柜台三项：充值登记、积分兑换、生日礼物核销。顾客站在柜台前当场办，所有员工都能办（权限由后端核对）。
// 小程序员工端「会员与计时 › 会员」也能办：两边同一个接口、同样的请求内容、同一句确认话。
// 三项共用一个写操作：一次只办一件，办理中其他按钮不能点（同小程序）；失败原因显示在办的那一块里。
// 入账、扣积分、出库都由后端算，成功后整页重读，页面上的余额、积分、待核销礼物都以接口为准。

type Section = 'recharge' | 'exchange' | 'gift'

/** 一次柜台办理：哪一块、点的是哪一行（规则或流水编号）、发什么请求、成功后提示什么。 */
interface CounterTask {
  section: Section
  target: string
  run: () => Promise<LoyaltyMember>
  before: LoyaltyEntry[]
  done: string
}

interface Confirmation {
  title: string
  content: ReactNode
  okText: string
}

export function CounterCards({
  member,
  accountId,
  label,
}: {
  member: LoyaltyMember
  accountId: string
  label: string
}) {
  const canBackdate = hasRole(useCurrentAccount(), 'manager', 'owner')
  const [serviceDate, setServiceDate] = useState(storeToday)
  const queryClient = useQueryClient()
  const [registered, setRegistered] = useState<LoyaltyEntry>()
  const counter = useMutation({
    mutationFn: (task: CounterTask) => task.run(),
    onSuccess: (result, task) => {
      if (task.section === 'recharge') setRegistered(registeredEntry(task.before, result.entries, 'recharge'))
      Toast.success(task.done)
      void queryClient.invalidateQueries()
    },
    // 失败也重读一次：多半是资产、规则或库存刚变过，员工看着最新的再决定要不要再办（不自动重提）
    onError: () => void queryClient.invalidateQueries(),
  })
  // 确认框开着、请求在路上时不再接第二次点击（同小程序的 pending）
  const acting = useRef(false)
  const [method, setMethod] = useState<OfflineMethod>(defaultRechargeMethod)
  const methodGroup = useId()
  const recharges = useMemo(() => rechargeRules(member.rules), [member.rules])
  const exchanges = useMemo(() => exchangeRules(member.rules), [member.rules])
  const gifts = useMemo(() => pendingGifts(member.entries), [member.entries])
  const busy = counter.isPending
  const running = (target: string) => busy && counter.variables?.target === target
  // 确认的是点下去那一刻看到的资产：带上这一版的版本号，期间别人办过、规则变了，后端回 409，重读后再确认
  const version = member.version

  const act = async (task: CounterTask, confirmation: Confirmation) => {
    if (acting.current) return
    acting.current = true
    try {
      const confirmed = await confirmDialog(confirmation)
      if (!confirmed) return
      await counter.mutateAsync(task)
    } catch {
      // 失败原因显示在办的那一块里
    } finally {
      acting.current = false
    }
  }

  const recharge = (rule: LoyaltyRule) => {
    const error = serviceDateError(serviceDate, canBackdate)
    if (error) {
      Toast.warning(error)
      return
    }
    void act(
      {
        section: 'recharge',
        before: member.entries,
        target: rule.id,
        run: () => membersApi.recharge({ accountId, targetId: rule.id, expectedVersion: version, method, serviceDate }),
        done: `已登记充值「${rule.name}」`,
      },
      {
        title: '确认充值登记',
        okText: '确认入账',
        content: (
          <div>
            <div>会员：{label}</div>
            <div>充值方案：{rule.name}</div>
            <div>充值日期：{serviceDate}</div>
            <div>收款方式：{methodName(method)}</div>
            <div style={{ marginTop: 8 }}>{rechargeConfirmText(rule)}</div>
          </div>
        ),
      },
    )
  }

  const exchange = (rule: LoyaltyRule) =>
    void act(
      {
        section: 'exchange',
        before: member.entries,
        target: rule.id,
        run: () => membersApi.exchange({ accountId, targetId: rule.id, expectedVersion: version }),
        done: `已兑换「${rule.name}」，请把商品交给顾客`,
      },
      {
        title: '确认积分兑换',
        okText: '确认兑换',
        content: (
          <div>
            <div>会员：{label}</div>
            <div>当前可用积分：{member.balance.points.toLocaleString('zh-CN')}</div>
            <div style={{ marginTop: 8 }}>{exchangeConfirmText(rule)}</div>
          </div>
        ),
      },
    )

  const fulfill = (entry: LoyaltyEntry) => {
    const name = entry.rule?.name ?? '生日礼物'
    void act(
      {
        section: 'gift',
        before: member.entries,
        target: entry.id,
        run: () => membersApi.fulfillGift({ accountId, targetId: entry.id, expectedVersion: version }),
        done: `已核销生日礼物「${name}」，请把礼物交给顾客`,
      },
      {
        title: '确认核销生日礼物',
        okText: '确认核销',
        content: (
          <div>
            <div>会员：{label}</div>
            <div>
              生日礼物：{name}（{dateTime(entry.createdAt)} 领取）
            </div>
            <div style={{ marginTop: 8 }}>{giftConfirmText}</div>
          </div>
        ),
      },
    )
  }

  /** 这一块上次办理失败的原因；「上次已生效」不是失败，用提醒的样子。 */
  const failure = (section: Section) => {
    if (!counter.isError || counter.variables?.section !== section) return null
    const notice = isPreviousApplied(counter.error)
    return (
      <Banner
        type={notice ? 'warning' : 'danger'}
        closeIcon={null}
        style={{ marginBottom: 12 }}
        description={
          isConflict(counter.error)
            ? `${counterErrorMessage(counter.error)}（页面已重新读取，请核对最新资产后再办理）`
            : counterErrorMessage(counter.error)
        }
      />
    )
  }

  const actionButton = (target: string, text: string, onClick: () => void) => (
    <Button size="small" loading={running(target)} disabled={busy && !running(target)} onClick={onClick}>
      {text}
    </Button>
  )

  const rechargeColumns: ColumnProps<LoyaltyRule>[] = [
    {
      title: '充值方案',
      render: (_: unknown, rule: LoyaltyRule) => (
        <div>
          {rule.name}
          {rule.boardUses ? (
            <div>
              <Typography.Text type="tertiary" size="small">
                送智能豆板 {rule.boardUses} 次（不过期）
              </Typography.Text>
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: <Nowrap>充值金额</Nowrap>,
      align: 'right',
      render: (_: unknown, rule: LoyaltyRule) => <Nowrap>{money(rule.amountCents)}</Nowrap>,
    },
    {
      title: <Nowrap>赠送余额</Nowrap>,
      align: 'right',
      render: (_: unknown, rule: LoyaltyRule) => <Nowrap>{money(rule.giftCents)}</Nowrap>,
    },
    {
      title: <Nowrap>赠送积分</Nowrap>,
      align: 'right',
      render: (_: unknown, rule: LoyaltyRule) => <Nowrap>{rule.points.toLocaleString('zh-CN')}</Nowrap>,
    },
    {
      title: '',
      align: 'right',
      // 窄屏表格左右滑时按钮固定在右边，不用先滑过去才看得到
      fixed: 'right',
      width: 112,
      render: (_: unknown, rule: LoyaltyRule) => actionButton(rule.id, '登记充值', () => recharge(rule)),
    },
  ]
  const exchangeColumns: ColumnProps<LoyaltyRule>[] = [
    { title: '兑换商品', dataIndex: 'name' },
    {
      title: <Nowrap>所需积分</Nowrap>,
      align: 'right',
      render: (_: unknown, rule: LoyaltyRule) => <Nowrap>{rule.points.toLocaleString('zh-CN')}</Nowrap>,
    },
    {
      title: '',
      align: 'right',
      render: (_: unknown, rule: LoyaltyRule) => actionButton(rule.id, '兑换', () => exchange(rule)),
    },
  ]
  const giftColumns: ColumnProps<LoyaltyEntry>[] = [
    { title: '生日礼物', render: (_: unknown, entry: LoyaltyEntry) => entry.rule?.name ?? '生日礼物' },
    {
      title: <Nowrap>领取时间</Nowrap>,
      render: (_: unknown, entry: LoyaltyEntry) => <Nowrap>{dateTime(entry.createdAt)}</Nowrap>,
    },
    {
      title: '',
      align: 'right',
      render: (_: unknown, entry: LoyaltyEntry) => actionButton(entry.id, '核销', () => fulfill(entry)),
    },
  ]

  return (
    // 充值方案表列多，占满一行；兑换、礼物核销各三列，宽屏并排
    <Row gutter={[16, 16]}>
      <Col span={24}>
        <Card title="充值登记">
          {registered ? <CopyMemberEntry entry={registered} entries={member.entries} success /> : null}
          {failure('recharge')}
          <ServiceDateField
            label="充值日期"
            value={serviceDate}
            onChange={setServiceDate}
            canBackdate={canBackdate}
            disabled={busy}
          />
          <Field
            label="收款方式"
            labelMode="radiogroup"
            help="核实顾客的线下付款已经到账，再点方案登记；系统只记账，不经手收款。"
          >
            {() => (
              <RadioGroup
                type="button"
                name={`${methodGroup}-recharge-method`}
                disabled={busy}
                value={method}
                onChange={(event) => setMethod(event.target.value as OfflineMethod)}
              >
                {rechargeMethods.map((item) => (
                  <Radio key={item.value} value={item.value}>
                    {item.label}
                  </Radio>
                ))}
              </RadioGroup>
            )}
          </Field>
          <Table
            size="small"
            rowKey="id"
            dataSource={recharges}
            columns={rechargeColumns}
            pagination={false}
            // 手机上放不下五列：表格自己左右滑，不把方案名挤成一列竖字
            scroll={{ x: 560 }}
            empty="暂无已发布充值方案"
          />
        </Card>
      </Col>
      <Col span={24} xl={12}>
        <Card
          title="积分兑换"
          headerExtraContent={
            <Typography.Text type="tertiary">可用积分 {member.balance.points.toLocaleString('zh-CN')}</Typography.Text>
          }
        >
          {failure('exchange')}
          <Table
            size="small"
            rowKey="id"
            dataSource={exchanges}
            columns={exchangeColumns}
            pagination={false}
            empty="暂无已发布兑换商品"
          />
          <Typography.Paragraph type="tertiary" size="small" style={{ marginTop: 12 }}>
            兑换一次扣一份积分、出库一件商品；积分不够、次数或数量用完、库存不足时后端会拒绝并说明。
          </Typography.Paragraph>
        </Card>
      </Col>
      <Col span={24} xl={12}>
        <Card title="生日礼物核销">
          {failure('gift')}
          <Table
            size="small"
            rowKey="id"
            dataSource={gifts}
            columns={giftColumns}
            pagination={false}
            empty="没有待核销的生日礼物。顾客在小程序领取礼物类生日福利后出现在这里，把礼物交到顾客手上时核销。"
          />
        </Card>
      </Col>
    </Row>
  )
}
