import { IconSearch } from '@douyinfe/semi-icons'
import {
  Banner,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  Modal,
  Row,
  Table,
  Tag,
  TextArea,
  Toast,
  Typography,
} from '@douyinfe/semi-ui'
import type { ColumnProps } from '@douyinfe/semi-ui/lib/es/table'
import { revalidateLogic, useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { memberCodesApi } from '../../api/member-codes'
import { isMemberCode, memberCodeIn, useScanRelay } from '../../realtime/scans'
import { hasRole, useCurrentAccount } from '../../account'
import { accountQuery, type AccountLabel } from '../../api/accounts'
import { isPreviousApplied, type Page as ListPage } from '../../api/client'
import {
  loyaltyAccountQuery,
  loyaltyMembersQuery,
  membersApi,
  type LoyaltyEntry,
  type LoyaltyMember,
  type LoyaltyMemberSummary,
} from '../../api/members'
import { Nowrap } from '../../components/Nowrap'
import { Field } from '../../components/Field'
import { Page, QueryState } from '../../components/Page'
import { ConsumptionCard } from '../../features/members/ConsumptionCard'
import { CopyMemberEntry } from '../../features/members/CopyMemberEntry'
import { OpenMemberModal } from '../../features/members/OpenMemberModal'
import { ReverseConsumptionModal } from '../../features/members/ReverseConsumptionModal'
import { CounterCards } from '../../features/members/CounterCards'
import { ClaimPasswordCard } from '../../features/members/ClaimPasswordCard'
import {
  canRefundRecharge,
  canReverseConsumption,
  reversedConsumptionIds,
  entryTitle,
  entryDate,
  entryBalanceAfter,
  entriesById,
  entryReason,
  entrySource,
  grantedPointsExpiry,
  methodName,
  newestFirst,
  pointsChange,
  refundedRechargeIds,
} from '../../features/members/entries'
import { actionErrorMessage, isConflict } from '../../features/members/errors'
import {
  adjustChange,
  adjustFormSchema,
  adjustOutcome,
  adjustSummary,
  emptyAdjustForm,
  reasonMaxLength,
  refundFormSchema,
} from '../../features/members/forms'
import {
  birthdayLabel,
  discountLabel,
  memberPageSize,
  parseMembersSearch,
  shortId,
  signedMoney,
  signedPoints,
} from '../../features/members/members'
import { useSearchText } from '../../features/orders/useSearchText'
import { accountLabel } from '../../features/staff/roles'
import type { Account } from '../../session'
import { dateOnly, dateTime, money } from '../../lib/format'
import { confirmDialog } from '../../components/confirm'

// 会员资产：所有员工可代开会员、登记消费和充值、手动加减资产，另有兑换和礼物核销。
// 店长、老板可撤销消费，老板可退充值；都另记流水，不改写历史。

export const Route = createFileRoute('/_authed/members')({
  validateSearch: parseMembersSearch,
  component: MembersPage,
})

/** 流水每页条数（流水随会员一次读回，在页面上分页）。 */
const pageSize = 10

const kindColors: Record<string, 'green' | 'red' | 'blue' | 'amber' | 'cyan' | 'orange' | 'pink' | 'purple' | 'grey'> =
  {
    recharge: 'green',
    recharge_refund: 'red',
    refund: 'red',
    adjust: 'amber',
    checkout: 'blue',
    earned: 'cyan',
    exchange: 'orange',
    birthday: 'pink',
    fulfill_gift: 'purple',
    birthday_used: 'grey',
    tier: 'purple',
  }

function confirm(options: { title: string; content: ReactNode; okText: string; danger?: boolean }) {
  return confirmDialog({
    title: options.title,
    content: options.content,
    okText: options.okText,
    okType: options.danger ? 'danger' : 'primary',
  })
}

function labelOf(account: Account): NonNullable<AccountLabel> {
  const { phoneMasked } = account
  return { id: account.id, nickname: account.nickname, phoneMasked: typeof phoneMasked === 'string' ? phoneMasked : '' }
}

function MembersPage() {
  const me = useCurrentAccount()
  const isOwner = hasRole(me, 'owner')
  const canReverse = hasRole(me, 'manager', 'owner')
  const [opening, setOpening] = useState(false)
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  // 查找、排序、分页都在服务端，这里只取左边这一页
  const members = useQuery(loyaltyMembersQuery({ q: search.q, page: search.listPage ?? 1, pageSize: memberPageSize }))
  // 点中的那一行：翻到别的页、换了搜索词，右边的称呼仍然在
  const [picked, setPicked] = useState<LoyaltyMemberSummary | null>(null)
  const listed = members.data?.rows.find((member) => member.id === search.account)
  const known = listed ?? (picked?.id === search.account ? picked : undefined)
  // 直接打开带会员编号的地址、这位又不在当前页时，另读一下他的账户资料拿称呼
  const profile = useQuery({
    ...accountQuery(search.account ?? ''),
    enabled: Boolean(search.account) && !known && !members.isPending,
  })
  const memberSummary = useQuery({
    ...loyaltyMembersQuery({ q: search.account, page: 1, pageSize: memberPageSize }),
    enabled: Boolean(search.account) && !listed && !members.isPending,
    placeholderData: undefined,
  })
  const summary: (AccountLabel & { unclaimed?: true }) | undefined =
    listed ??
    memberSummary.data?.rows.find((row) => row.id === search.account) ??
    (picked?.id === search.account ? picked : undefined) ??
    (profile.data && profile.data.id === search.account ? labelOf(profile.data) : undefined)

  const select = (member: LoyaltyMemberSummary) => {
    setPicked(member)
    void navigate({ search: (prev) => ({ ...prev, account: member.id, page: undefined }) })
  }
  const [text, setText] = useSearchText(
    search.q ?? '',
    (q) => void navigate({ search: (prev) => ({ ...prev, q: q || undefined, listPage: undefined }), replace: true }),
  )
  // 会员码（2026-10-06）：柜台扫码枪对着查找框扫顾客的会员码，或本人手机「扫码给电脑」转来，直接打开这位会员
  const lookup = useMutation({
    mutationFn: memberCodesApi.lookup,
    onSuccess: (found) => {
      select({ id: found.id, nickname: found.nickname, phoneMasked: found.phoneMasked, balance: found.balance })
      Toast.success(`已按会员码找到「${found.nickname}」`)
    },
  })
  const typeSearch = (value: string) => {
    const code = memberCodeIn(value)
    if (code) {
      // 会员码不当搜索词：框里清掉，按码查人
      setText('')
      lookup.mutate(code)
      return
    }
    lookup.reset()
    setText(value)
  }
  useScanRelay((code) => {
    if (!isMemberCode(code)) return false
    lookup.mutate(code.trim())
    return true
  })
  const setListPage = (page: number) =>
    void navigate({ search: (prev) => ({ ...prev, listPage: page > 1 ? page : undefined }) })
  const setPage = (page: number) =>
    void navigate({ search: (prev) => ({ ...prev, page: page > 1 ? page : undefined }) })

  return (
    <Page
      title="会员资产"
      description="查会员的余额、积分、智能豆板次数与流水，办理消费登记、充值和代开会员。可扫会员码查找，手动加减须写原因；店长、老板可撤销消费，充值退款由老板办理。都另记流水，保留历史。"
    >
      <Button onClick={() => setOpening(true)} style={{ marginBottom: 16 }}>
        代开会员
      </Button>
      {opening ? <OpenMemberModal onClose={() => setOpening(false)} onOpened={select} /> : null}
      <Row gutter={[16, 16]}>
        <Col span={24} xl={6}>
          <Card title="查找会员">
            <Input
              prefix={<IconSearch />}
              showClear
              placeholder="昵称、手机尾号、编号，或扫会员码"
              aria-label="查找会员"
              value={text}
              onChange={typeSearch}
              style={{ marginBottom: 12 }}
            />
            {lookup.isPending ? (
              <div role="status" style={{ marginBottom: 12 }}>
                <Typography.Text type="tertiary" size="small">
                  正在按会员码查找…
                </Typography.Text>
              </div>
            ) : lookup.isError ? (
              <Banner type="danger" closeIcon={null} style={{ marginBottom: 12 }} description={lookup.error.message} />
            ) : null}
            <QueryState query={members}>
              {(current) => (
                <MemberList current={current} selectedId={search.account} onSelect={select} onPage={setListPage} />
              )}
            </QueryState>
          </Card>
        </Col>
        <Col span={24} xl={18}>
          {search.account ? (
            <MemberDetail
              key={search.account}
              accountId={search.account}
              summary={summary}
              isOwner={isOwner}
              canReverse={canReverse}
              page={search.page ?? 1}
              onPage={setPage}
            />
          ) : (
            <Card>
              <Empty
                title="先选一位会员"
                description="在左边按昵称、手机尾号或编号查找，点一行查看资产与流水。"
                style={{ padding: 32 }}
              />
            </Card>
          )}
        </Col>
      </Row>
    </Page>
  )
}

/** 金额、时间这类短内容不折行（窄列里 + 号和数字被拆成两行很难读）。 */
function MemberList({
  current,
  selectedId,
  onSelect,
  onPage,
}: {
  current: ListPage<LoyaltyMemberSummary>
  selectedId: string | undefined
  onSelect: (member: LoyaltyMemberSummary) => void
  onPage: (page: number) => void
}) {
  const columns: ColumnProps<LoyaltyMemberSummary>[] = [
    {
      title: '会员',
      render: (_: unknown, row: LoyaltyMemberSummary) => (
        <div>
          <Typography.Text strong>{row.nickname}</Typography.Text>
          {row.unclaimed ? (
            <div>
              <Tag>店员代开 · 未认领</Tag>
            </div>
          ) : null}
          <div>
            <Typography.Text type="tertiary" size="small">
              {row.phoneMasked || '未留手机号'} · {shortId(row.id)}
            </Typography.Text>
          </div>
        </div>
      ),
    },
    {
      title: <Nowrap>余额</Nowrap>,
      align: 'right',
      render: (_: unknown, row: LoyaltyMemberSummary) => (
        <div>
          <Nowrap>{money(row.balance.principalCents + row.balance.giftCents)}</Nowrap>
          {row.balance.giftCents ? (
            <div>
              <Typography.Text type="tertiary" size="small">
                其中赠送 {money(row.balance.giftCents)}
              </Typography.Text>
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: <Nowrap>豆板</Nowrap>,
      align: 'right',
      render: (_: unknown, row: LoyaltyMemberSummary) => <Nowrap>{row.balance.boardUses ?? 0} 次</Nowrap>,
    },
    {
      title: <Nowrap>积分</Nowrap>,
      align: 'right',
      render: (_: unknown, row: LoyaltyMemberSummary) => <Nowrap>{row.balance.points.toLocaleString('zh-CN')}</Nowrap>,
    },
  ]
  return (
    <Table
      size="small"
      rowKey="id"
      dataSource={current.rows}
      columns={columns}
      pagination={
        current.total > memberPageSize
          ? { currentPage: current.page, pageSize: memberPageSize, total: current.total, onPageChange: onPage }
          : false
      }
      empty="没有匹配的会员"
      onRow={(record) => ({
        onClick: () => record && onSelect(record),
        'aria-selected': record?.id === selectedId,
        style: {
          cursor: 'pointer',
          background: record?.id === selectedId ? 'var(--semi-color-primary-light-default)' : undefined,
        },
      })}
    />
  )
}

function MemberDetail({
  accountId,
  summary,
  isOwner,
  canReverse,
  page,
  onPage,
}: {
  accountId: string
  /** 会员称呼：来自左边列表里点中的那一行，或另读的账户资料；读到之前只显示编号。 */
  summary: (AccountLabel & { unclaimed?: true }) | undefined
  isOwner: boolean
  canReverse: boolean
  page: number
  onPage: (page: number) => void
}) {
  const query = useQuery(loyaltyAccountQuery(accountId))
  const label = summary ? accountLabel(summary) : `编号 ${shortId(accountId)}`
  const reload = () => void query.refetch()

  if (query.isError && query.data === undefined && (query.error as { status?: number }).status === 404) {
    return (
      <Card>
        <Empty
          title="没有找到这位会员"
          description="编号可能写错了，或这个账号已不存在。请在左边重新查找。"
          style={{ padding: 32 }}
        />
      </Card>
    )
  }
  return (
    <QueryState query={query}>
      {(member) => (
        // 一列宽度不跟着最宽的表格撑开（手机上充值方案表放不下时在卡片里左右滑，不把整页撑出屏幕）
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <AssetsCard member={member} summary={summary} accountId={accountId} />
          <ConsumptionCard member={member} accountId={accountId} label={label} />
          <CounterCards member={member} accountId={accountId} label={label} />
          <ClaimPasswordCard accountId={accountId} label={label} />
          <AdjustCard member={member} accountId={accountId} label={label} onReload={reload} />
          {isOwner ? null : <Banner type="info" closeIcon={null} description="充值退款只有老板能办理。" />}
          <EntriesCard
            member={member}
            accountId={accountId}
            label={label}
            isOwner={isOwner}
            canReverse={canReverse}
            page={page}
            onPage={onPage}
            onReload={reload}
          />
        </div>
      )}
    </QueryState>
  )
}

function AssetsCard({
  member,
  summary,
  accountId,
}: {
  member: LoyaltyMember
  summary: (AccountLabel & { unclaimed?: true }) | undefined
  accountId: string
}) {
  const { balance, profile } = member
  return (
    <Card
      title={summary?.nickname ?? '会员'}
      headerExtraContent={
        <Typography.Text type="tertiary">
          {summary?.phoneMasked || '未留手机号'} · 编号 {shortId(accountId)}
        </Typography.Text>
      }
    >
      {summary?.unclaimed ? (
        <Banner
          type="info"
          closeIcon={null}
          title="店员代开 · 未认领"
          description="顾客在小程序登录页点「店员帮我开过会员，去认领」，填手机号和员工给的临时密码即可认领；请用下方「发临时密码」发临时密码。"
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Descriptions
        row
        size="large"
        data={[
          {
            key: '余额',
            value: (
              <div>
                {money(balance.principalCents + balance.giftCents)}
                {balance.giftCents ? (
                  <div>
                    <Typography.Text type="tertiary" size="small">
                      其中赠送 {money(balance.giftCents)}
                    </Typography.Text>
                  </div>
                ) : null}
              </div>
            ),
          },
          { key: '智能豆板', value: `剩 ${balance.boardUses ?? 0} 次` },
          { key: '可用积分', value: balance.points.toLocaleString('zh-CN') },
          { key: '30 天内到期积分', value: balance.expiringPoints.toLocaleString('zh-CN') },
        ]}
      />
      <Descriptions
        style={{ marginTop: 16 }}
        data={[
          { key: '会员等级', value: balance.tierName },
          { key: '会员折扣', value: discountLabel(balance.rateBasisPoints) },
          { key: '生日', value: birthdayLabel(profile) },
        ]}
      />
    </Card>
  )
}

/**
 * 手动加减（所有员工，2026-10-10 起；钱在美团、大众点评收，储值和积分改由员工手动加减）：
 * 本金、赠送余额、积分可正可负，原因必填；确认时绑定读到的会员资产版本。
 */
function AdjustCard({
  member,
  accountId,
  label,
  onReload,
}: {
  member: LoyaltyMember
  accountId: string
  label: string
  onReload: () => void
}) {
  const queryClient = useQueryClient()
  const adjust = useMutation({
    mutationFn: membersApi.adjust,
    onSuccess: () => {
      Toast.success('已调整，另记了一条「资产调整」流水')
      void queryClient.invalidateQueries()
    },
  })
  const form = useForm({
    defaultValues: emptyAdjustForm,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: adjustFormSchema },
    onSubmit: async ({ value, formApi }) => {
      const change = adjustChange(value)
      if (!change) return
      // 确认的是此刻看到的资产：带上这一版的版本号，期间别人办了充值或消费，后端回 409，重读后再确认
      const expectedVersion = member.version
      const { balance } = member
      const { after, short } = adjustOutcome(balance, change)
      if (short.length > 0) {
        Toast.warning(`${short.join('、')}不够扣：调整后不能是负数，请核对后再填`)
        return
      }
      const confirmed = await confirm({
        title: '确认手动加减',
        okText: '确认调整',
        content: (
          <div>
            <div>会员：{label}</div>
            <div>
              当前：本金 {money(balance.principalCents)}、赠送余额 {money(balance.giftCents)}、积分{' '}
              {balance.points.toLocaleString('zh-CN')}、智能豆板 {balance.boardUses ?? 0} 次
            </div>
            <div>本次调整：{adjustSummary(change)}</div>
            <div>
              调整后：本金 {money(after.principalCents)}、赠送余额 {money(after.giftCents)}、积分{' '}
              {after.points.toLocaleString('zh-CN')}、智能豆板 {after.boardUses} 次
            </div>
            <div>原因：{change.reason}</div>
            <div style={{ marginTop: 8 }}>
              <Typography.Text type="tertiary">调整另记一条「资产调整」流水，不改写已有记录。</Typography.Text>
            </div>
          </div>
        ),
      })
      if (!confirmed) return
      try {
        await adjust.mutateAsync({ accountId, expectedVersion, ...change })
        formApi.reset()
      } catch {
        // 失败原因显示在卡片上方，输入保留
      }
    },
  })

  return (
    <Card title="手动加减">
      {adjust.isError ? (
        // 上一次没收到结果的同一调整其实已经生效、这次没提交（见 api/client.ts）：不是失败，用提醒的样子
        <Banner
          type={isPreviousApplied(adjust.error) ? 'warning' : 'danger'}
          closeIcon={null}
          style={{ marginBottom: 12 }}
          description={
            <span>
              {actionErrorMessage(adjust.error)}
              {isConflict(adjust.error) ? (
                <>
                  {' '}
                  请重新读取，核对最新资产后再提交。{' '}
                  <Button
                    size="small"
                    theme="borderless"
                    onClick={() => {
                      adjust.reset()
                      onReload()
                    }}
                  >
                    重新读取
                  </Button>
                </>
              ) : null}
            </span>
          }
        />
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <Row gutter={16}>
          <Col span={24} md={8}>
            <form.Field name="principal">
              {(field) => (
                <Field label="本金调整（元）" errors={field.state.meta.errors}>
                  {(control) => (
                    <Input
                      {...control}
                      placeholder="如 -20 或 15.5"
                      value={field.state.value}
                      onChange={(value) => field.handleChange(value)}
                      onBlur={field.handleBlur}
                    />
                  )}
                </Field>
              )}
            </form.Field>
          </Col>
          <Col span={24} md={8}>
            <form.Field name="gift">
              {(field) => (
                <Field label="赠送余额调整（元）" errors={field.state.meta.errors}>
                  {(control) => (
                    <Input
                      {...control}
                      placeholder="如 -5"
                      value={field.state.value}
                      onChange={(value) => field.handleChange(value)}
                      onBlur={field.handleBlur}
                    />
                  )}
                </Field>
              )}
            </form.Field>
          </Col>
          <Col span={24} md={8}>
            <form.Field name="points">
              {(field) => (
                <Field label="积分调整" errors={field.state.meta.errors}>
                  {(control) => (
                    <Input
                      {...control}
                      placeholder="如 -100"
                      value={field.state.value}
                      onChange={(value) => field.handleChange(value)}
                      onBlur={field.handleBlur}
                    />
                  )}
                </Field>
              )}
            </form.Field>
          </Col>
        </Row>
        <form.Field name="boardUses">
          {(field) => (
            <Field label="智能豆板次数调整" errors={field.state.meta.errors}>
              {(control) => (
                <Input
                  {...control}
                  inputMode="numeric"
                  placeholder="如 -1 或 2"
                  value={field.state.value}
                  onChange={field.handleChange}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>
        <Typography.Paragraph type="tertiary" size="small" style={{ marginBottom: 16 }}>
          正数增加、负数扣减，留空表示这一项不调。扣积分按最早到期的批次扣，加的积分永久有效；不能扣成负数。每次调整记操作人和原因，顾客的流水里显示「资产调整」和原因。
        </Typography.Paragraph>
        <form.Field name="reason">
          {(field) => (
            <Field label="调整原因" errors={field.state.meta.errors}>
              {(control) => (
                <TextArea
                  {...control}
                  autosize
                  rows={2}
                  maxCount={reasonMaxLength}
                  placeholder="写清为什么调整，例如：10 月 2 日充值时本金录多了 20 元"
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button htmlType="submit" theme="solid" type="primary" loading={submitting || adjust.isPending}>
              提交调整
            </Button>
          )}
        </form.Subscribe>
      </form>
    </Card>
  )
}

function EntriesCard({
  member,
  accountId,
  label,
  isOwner,
  canReverse,
  page,
  onPage,
  onReload,
}: {
  member: LoyaltyMember
  accountId: string
  label: string
  isOwner: boolean
  canReverse: boolean
  page: number
  onPage: (page: number) => void
  onReload: () => void
}) {
  const [reversing, setReversing] = useState<LoyaltyEntry | null>(null)
  const [refunding, setRefunding] = useState<LoyaltyEntry | null>(null)
  const rows = newestFirst(member.entries)
  const byId = entriesById(member.entries)
  const refunded = refundedRechargeIds(member.entries)
  const reversed = reversedConsumptionIds(member.entries)
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)))

  const columns: ColumnProps<LoyaltyEntry>[] = [
    { title: '日期', render: (_: unknown, row: LoyaltyEntry) => <Nowrap>{entryDate(row)}</Nowrap> },
    {
      title: '类型',
      dataIndex: 'kind',
      render: (kind: string, row: LoyaltyEntry) => (
        <span className="tag-list">
          <Tag color={kindColors[kind] ?? 'grey'}>{entryTitle(row)}</Tag>
          {refunded.has(row.id) ? <Tag color="grey">已退款</Tag> : null}
          {reversed.has(row.id) ? <Tag color="grey">已撤销</Tag> : null}
        </span>
      ),
    },
    {
      title: <Nowrap>本金</Nowrap>,
      align: 'right',
      render: (_: unknown, row: LoyaltyEntry) => (
        <Nowrap>{row.principalCents ? signedMoney(row.principalCents) : '—'}</Nowrap>
      ),
    },
    {
      title: <Nowrap>赠送余额</Nowrap>,
      align: 'right',
      render: (_: unknown, row: LoyaltyEntry) => <Nowrap>{row.giftCents ? signedMoney(row.giftCents) : '—'}</Nowrap>,
    },
    {
      title: <Nowrap>积分</Nowrap>,
      align: 'right',
      render: (_: unknown, row: LoyaltyEntry) => {
        const points = pointsChange(row)
        const expiresAt = grantedPointsExpiry(row)
        if (!points) return '—'
        return (
          <Nowrap>
            {signedPoints(points)}
            {expiresAt ? (
              <div>
                <Typography.Text type="tertiary" size="small">
                  {dateOnly(expiresAt)} 到期
                </Typography.Text>
              </div>
            ) : null}
          </Nowrap>
        )
      },
    },
    {
      title: '来源与备注',
      // 说明文字最长，给足宽度；整张表放不下时横向滚动，不让它逐字换行
      width: 260,
      render: (_: unknown, row: LoyaltyEntry) => {
        const reason = entryReason(row)
        return (
          <div>
            {entrySource(row, byId)}
            {row.boardUses ? <div>智能豆板 {signedPoints(row.boardUses)} 次</div> : null}
            {row.consumption?.extraCents ? <div>余额不够，另付 {money(row.consumption.extraCents)}</div> : null}
            {row.balanceAfter ? <div>{entryBalanceAfter(row)}</div> : null}
            <CopyMemberEntry entry={row} entries={member.entries} />
            {reason ? (
              <div>
                <Typography.Text type="tertiary" size="small">
                  {row.kind === 'consume' ? '备注' : '原因'}：{reason}
                </Typography.Text>
              </div>
            ) : null}
          </div>
        )
      },
    },
  ]
  if (isOwner || canReverse) {
    columns.push({
      title: '',
      render: (_: unknown, row: LoyaltyEntry) =>
        isOwner && canRefundRecharge(row, refunded) ? (
          <Button size="small" type="danger" theme="borderless" onClick={() => setRefunding(row)}>
            退款
          </Button>
        ) : canReverse && canReverseConsumption(row, reversed) ? (
          <Button size="small" type="danger" theme="borderless" onClick={() => setReversing(row)}>
            撤销
          </Button>
        ) : null,
    })
  }

  return (
    <Card
      title="资产流水"
      headerExtraContent={<Typography.Text type="tertiary">共 {rows.length} 条，最新的在前</Typography.Text>}
    >
      <Table
        size="small"
        rowKey="id"
        // 接口一次给全部流水；页码受网址控制时 Semi 不替我们切数据，这里按页切好再给它
        dataSource={rows.slice((current - 1) * pageSize, current * pageSize)}
        columns={columns}
        scroll={{ x: 860 }}
        empty="还没有资产流水"
        pagination={
          rows.length > pageSize ? { currentPage: current, pageSize, total: rows.length, onPageChange: onPage } : false
        }
      />
      {reversing ? (
        <ReverseConsumptionModal
          entry={reversing}
          accountId={accountId}
          expectedVersion={member.version}
          onClose={() => setReversing(null)}
          onReload={onReload}
        />
      ) : null}
      {refunding ? (
        <RechargeRefundModal
          entry={refunding}
          accountId={accountId}
          label={label}
          onClose={() => setRefunding(null)}
          onReload={onReload}
        />
      ) : null}
    </Card>
  )
}

/** 充值退款（老板）：整笔退回本金，收回这笔的赠送余额与积分；先填原因，再确认。 */
function RechargeRefundModal({
  entry,
  accountId,
  label,
  onClose,
  onReload,
}: {
  entry: LoyaltyEntry
  accountId: string
  label: string
  onClose: () => void
  onReload: () => void
}) {
  const queryClient = useQueryClient()
  const refund = useMutation({
    mutationFn: membersApi.rechargeRefund,
    onSuccess: () => {
      Toast.success('充值已退款，另记了一条「充值退款」冲正流水')
      void queryClient.invalidateQueries()
      onClose()
    },
  })
  const points = pointsChange(entry)
  const method = methodName(entry.method)
  const form = useForm({
    defaultValues: { reason: '' },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: refundFormSchema },
    onSubmit: async ({ value }) => {
      const reason = value.reason.trim()
      const confirmed = await confirm({
        title: '确认充值退款',
        okText: '确认退款',
        danger: true,
        content: (
          <div>
            <div>会员：{label}</div>
            <div>
              退回：{dateTime(entry.createdAt)} 的充值{entry.rule?.name ? `「${entry.rule.name}」` : ''}
            </div>
            <div>退回本金 {money(entry.principalCents)}</div>
            <div>
              收回赠送余额 {money(entry.giftCents)}、积分 {points.toLocaleString('zh-CN')}
              {entry.boardUses ? `、智能豆板 ${entry.boardUses} 次` : ''}
            </div>
            <div>原因：{reason}</div>
            <div style={{ marginTop: 8 }}>
              <Typography.Text type="tertiary">
                {method ? `本金请按原渠道（${method}）线下退给顾客。` : '本金请按原渠道线下退给顾客。'}
                另记一条「充值退款」冲正流水，原充值记录保留。
              </Typography.Text>
            </div>
          </div>
        ),
      })
      if (!confirmed) return
      try {
        await refund.mutateAsync({ accountId, targetId: entry.id, reason })
      } catch {
        // 失败原因显示在弹窗里
      }
    },
  })

  return (
    <Modal
      visible
      title="充值退款"
      maskClosable={false}
      onCancel={onClose}
      footer={
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <>
              <Button onClick={onClose} disabled={submitting}>
                取消
              </Button>
              <Button
                type="danger"
                theme="solid"
                loading={submitting || refund.isPending}
                onClick={() => void form.handleSubmit()}
              >
                下一步
              </Button>
            </>
          )}
        </form.Subscribe>
      }
    >
      {refund.isError ? (
        <Banner
          type={isPreviousApplied(refund.error) ? 'warning' : 'danger'}
          closeIcon={null}
          style={{ marginBottom: 12 }}
          description={
            <span>
              {actionErrorMessage(refund.error)}
              {isConflict(refund.error) ? (
                <>
                  {' '}
                  <Button
                    size="small"
                    theme="borderless"
                    onClick={() => {
                      onReload()
                      onClose()
                    }}
                  >
                    重新读取
                  </Button>
                </>
              ) : null}
            </span>
          }
        />
      ) : null}
      <Descriptions
        data={[
          { key: '会员', value: label },
          { key: '充值时间', value: dateTime(entry.createdAt) },
          { key: '充值方案', value: entry.rule?.name ?? '—' },
          { key: '收款方式', value: method || '—' },
          { key: '退回本金', value: money(entry.principalCents) },
          { key: '收回赠送余额', value: money(entry.giftCents) },
          { key: '收回积分', value: points.toLocaleString('zh-CN') },
          ...(entry.boardUses ? [{ key: '收回智能豆板', value: `${entry.boardUses} 次` }] : []),
        ]}
      />
      <form
        style={{ marginTop: 16 }}
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.Field name="reason">
          {(field) => (
            <Field
              label="退款原因"
              help="余额或这笔积分已被用掉时后端会拒绝，需要先和顾客核对。"
              errors={field.state.meta.errors}
            >
              {(control) => (
                <TextArea
                  {...control}
                  autosize
                  rows={2}
                  maxCount={reasonMaxLength}
                  placeholder="例如：顾客搬家，退回未用的储值"
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>
      </form>
    </Modal>
  )
}
