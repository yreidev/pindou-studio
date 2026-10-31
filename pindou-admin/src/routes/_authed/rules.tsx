import { Banner, Button, Empty, Space, Table, Tabs, Tag, Toast, Typography } from '@douyinfe/semi-ui'
import { IconPlus } from '@douyinfe/semi-icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { hasRole, useCurrentAccount } from '../../account'
import {
  catalogItemsQuery,
  loyaltySettingsQuery,
  rulePreviewQuery,
  ruleKinds,
  type CatalogItem,
  type LoyaltyRule,
  type LoyaltySettings,
  type PublicationRecord,
  type RuleKind,
} from '../../api/rules'
import { Nowrap } from '../../components/Nowrap'
import { Page, QueryState } from '../../components/Page'
import {
  actorName,
  parseRulesSearch,
  publicationAction,
  ruleKindHelp,
  ruleKindNames,
  ruleRows,
  ruleSummary,
  statusNames,
  type RuleRow,
  type RulesTab,
} from '../../features/rules/display'
import { blankRule } from '../../features/rules/form'
import { PublishDialog, type PublishTarget } from '../../features/rules/PublishDialog'
import { RuleEditor, type EditTarget } from '../../features/rules/RuleEditor'
import { dateTime } from '../../lib/format'
import '../../features/rules/rules.css'
import { confirmDialog } from '../../components/confirm'

export const Route = createFileRoute('/_authed/rules')({
  validateSearch: parseRulesSearch,
  component: RulesPage,
})

const statusColors = { active: 'green', disabled: 'grey', unpublished: 'blue' } as const

function RulesPage() {
  const me = useCurrentAccount()
  // 店长、老板编草稿和看计算示例；只有老板发布、停用。界面只是隐藏，权限以后端为准。
  const canEdit = hasRole(me, 'manager', 'owner')
  const canPublish = hasRole(me, 'owner')
  const { tab = 'tier' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const queryClient = useQueryClient()
  const settings = useQuery(loyaltySettingsQuery())
  const catalog = useQuery(catalogItemsQuery())
  const products = catalog.data ?? []
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [publishing, setPublishing] = useState<PublishTarget | null>(null)
  const [previewing, setPreviewing] = useState<string | null>(null)

  const showPreview = async (rule: LoyaltyRule) => {
    setPreviewing(rule.id)
    try {
      const text = await queryClient.fetchQuery(rulePreviewQuery(rule))
      void confirmDialog({
        variant: 'info',
        title: `计算示例 · ${rule.name}`,
        content: text,
        okText: '知道了',
        hasCancel: false,
      })
    } catch (error) {
      Toast.error(error instanceof Error ? error.message : '计算示例读取失败')
    } finally {
      setPreviewing(null)
    }
  }

  return (
    <Page
      title="经营规则"
      description="会员等级、充值、积分、生日福利和计时套餐。保存草稿不影响营业；老板发布后，新的交易按新规则计算，已有资产、已获等级和已购买的套餐保留原记录。顾客只看到已发布且启用的规则。"
    >
      {canEdit && !canPublish ? (
        <Banner
          type="info"
          closeIcon={null}
          description="你可以新建、修改草稿并查看计算示例；发布和停用由老板操作。"
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {!canEdit ? (
        <Banner
          type="info"
          closeIcon={null}
          description="当前身份只能查看。规则草稿由店长或老板维护，老板发布。"
          style={{ marginBottom: 12 }}
        />
      ) : null}
      <Tabs
        type="line"
        // 放不下（手机上）时由 Semi 自动改成左右箭头滚动，不折成两行
        collapsible="auto"
        activeKey={tab}
        onChange={(key) => void navigate({ search: { tab: key as RulesTab } })}
        tabList={[
          ...ruleKinds.map((kind) => ({ itemKey: kind, tab: ruleKindNames[kind] })),
          { itemKey: 'history', tab: '发布历史' },
        ]}
      />
      <div className="rules-panel">
        <QueryState query={settings}>
          {(data) =>
            tab === 'history' ? (
              <History data={data} products={products} />
            ) : (
              <KindPanel
                kind={tab}
                data={data}
                products={products}
                canEdit={canEdit}
                canPublish={canPublish}
                previewing={previewing}
                onCreate={() => setEditing({ rule: blankRule(tab), version: data.version, active: false })}
                onEdit={(row) =>
                  setEditing({ rule: row.draft, version: data.version, active: row.status === 'active' })
                }
                onPreview={(row) => void showPreview(row.draft)}
                onPublish={(row, action) =>
                  setPublishing({ action, rule: row.draft, active: row.active, version: data.version })
                }
              />
            )
          }
        </QueryState>
      </div>
      {editing ? (
        <RuleEditor
          target={editing}
          products={products}
          productsFailed={catalog.isError}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {publishing ? (
        <PublishDialog
          target={publishing}
          others={(settings.data?.rules ?? []).filter(
            (rule) => rule.kind === publishing.rule.kind && rule.id !== publishing.rule.id,
          )}
          products={products}
          onClose={() => setPublishing(null)}
        />
      ) : null}
    </Page>
  )
}

function KindPanel({
  kind,
  data,
  products,
  canEdit,
  canPublish,
  previewing,
  onCreate,
  onEdit,
  onPreview,
  onPublish,
}: {
  kind: RuleKind
  data: LoyaltySettings
  products: CatalogItem[]
  canEdit: boolean
  canPublish: boolean
  previewing: string | null
  onCreate: () => void
  onEdit: (row: RuleRow) => void
  onPreview: (row: RuleRow) => void
  onPublish: (row: RuleRow, action: 'publish' | 'disable') => void
}) {
  const rows = ruleRows(data, kind)
  const name = ruleKindNames[kind]
  const activeCount = rows.filter((row) => row.status === 'active').length

  return (
    <>
      <div className="toolbar rules-toolbar">
        <Typography.Text type="tertiary">{ruleKindHelp[kind]}</Typography.Text>
        {canEdit ? (
          <Button theme="solid" type="primary" icon={<IconPlus />} onClick={onCreate}>
            新建{name}
          </Button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <Empty
          title={`尚未配置${name}`}
          description="未配置时顾客看不到这一项，交易也不适用。新建并保存草稿后可以查看计算示例，再由老板发布。"
        />
      ) : (
        <>
          {activeCount === 0 ? (
            <Banner
              type="warning"
              closeIcon={null}
              description={`当前没有生效的${name}：顾客端不展示，交易也不适用。`}
              style={{ marginBottom: 12 }}
            />
          ) : null}
          <Table
            size="small"
            rowKey={(row?: RuleRow) => row?.draft.id ?? ''}
            dataSource={rows}
            pagination={false}
            columns={[
              { title: '名称', width: 160, render: (_: unknown, row: RuleRow) => row.draft.name },
              {
                title: '状态',
                width: 180,
                render: (_: unknown, row: RuleRow) => (
                  <Space wrap spacing={4}>
                    <Tag color={statusColors[row.status]}>{statusNames[row.status]}</Tag>
                    {row.changed ? <Tag color="orange">有未发布的修改</Tag> : null}
                  </Space>
                ),
              },
              {
                title: '内容',
                render: (_: unknown, row: RuleRow) => (
                  <div className="rule-content">
                    <span>{ruleSummary(row.draft, products)}</span>
                    {row.changed && row.active ? (
                      <Typography.Text type="tertiary" size="small">
                        生效中：{ruleSummary(row.active, products)}
                      </Typography.Text>
                    ) : null}
                  </div>
                ),
              },
              {
                title: '最近发布',
                width: 200,
                render: (_: unknown, row: RuleRow) =>
                  row.latest ? (
                    <div className="rule-content">
                      <Nowrap>{dateTime(row.latest.createdAt)}</Nowrap>
                      <Typography.Text type="tertiary" size="small">
                        {publicationAction(row.latest)} · {actorName(row.latest)}
                      </Typography.Text>
                    </div>
                  ) : (
                    <Typography.Text type="tertiary">—</Typography.Text>
                  ),
              },
              {
                title: '',
                width: 260,
                render: (_: unknown, row: RuleRow) => (
                  <Space wrap spacing={4}>
                    {canEdit ? (
                      <>
                        <Button size="small" theme="borderless" onClick={() => onEdit(row)}>
                          编辑
                        </Button>
                        <Button
                          size="small"
                          theme="borderless"
                          loading={previewing === row.draft.id}
                          onClick={() => onPreview(row)}
                        >
                          计算示例
                        </Button>
                      </>
                    ) : null}
                    {canPublish && (row.status !== 'active' || row.changed) ? (
                      <Button size="small" theme="borderless" type="primary" onClick={() => onPublish(row, 'publish')}>
                        {row.changed ? '发布修改' : row.status === 'disabled' ? '重新发布' : '发布'}
                      </Button>
                    ) : null}
                    {canPublish && row.status === 'active' ? (
                      <Button size="small" theme="borderless" type="danger" onClick={() => onPublish(row, 'disable')}>
                        停用
                      </Button>
                    ) : null}
                  </Space>
                ),
              },
            ]}
          />
        </>
      )}
    </>
  )
}

function History({ data, products }: { data: LoyaltySettings; products: CatalogItem[] }) {
  return (
    <>
      <div className="toolbar rules-toolbar">
        <Typography.Text type="tertiary">
          每次发布和停用都留一条记录，不能修改或删除。内容是当时的规则，修改规则不会追改历史交易。
        </Typography.Text>
      </div>
      <Table
        size="small"
        rowKey="id"
        dataSource={data.publications}
        pagination={data.publications.length > 20 ? { pageSize: 20 } : false}
        empty="还没有发布记录"
        columns={[
          {
            title: '时间',
            dataIndex: 'createdAt',
            width: 150,
            render: (value: string) => <Nowrap>{dateTime(value)}</Nowrap>,
          },
          {
            title: '操作',
            width: 80,
            render: (_: unknown, row: PublicationRecord) => (
              <Tag color={row.rule.enabled ? 'green' : 'grey'}>{publicationAction(row)}</Tag>
            ),
          },
          {
            title: '规则',
            width: 180,
            render: (_: unknown, row: PublicationRecord) => (
              <div className="rule-content">
                <span>{row.rule.name}</span>
                <Typography.Text type="tertiary" size="small">
                  {ruleKindNames[row.rule.kind] ?? row.rule.kind}
                </Typography.Text>
              </div>
            ),
          },
          {
            title: '当时的内容',
            render: (_: unknown, row: PublicationRecord) => ruleSummary(row.rule, products),
          },
          { title: '影响说明', dataIndex: 'impact', width: 240 },
          {
            title: '操作人',
            width: 100,
            render: (_: unknown, row: PublicationRecord) => actorName(row),
          },
        ]}
      />
    </>
  )
}
