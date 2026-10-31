import { IconSearch } from '@douyinfe/semi-icons'
import { Banner, Button, Card, Empty, Input, Table, Tabs, Toast, Typography } from '@douyinfe/semi-ui'
import { useDebouncedCallback } from '@tanstack/react-pacer'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { hasRole, useCurrentAccount } from '../../account'
import { operationsApi, type AuditEvent } from '../../api/operations'
import { Nowrap } from '../../components/Nowrap'
import { Page, QueryState } from '../../components/Page'
import { actionsMatching, auditActor, auditName } from '../../features/operations/audit'
import { dataExportFilename } from '../../features/operations/dataExport'
import {
  exportFilename,
  exportOptions,
  exportRangeError,
  quickRanges,
  type ExportOption,
} from '../../features/operations/exports'
import { readableError } from '../../features/operations/messages'
import {
  currentTab,
  operationsSearchSchema,
  operationsTabs,
  type OperationsSearch,
  type OperationsTab,
} from '../../features/operations/search'
import { dateTime, storeToday } from '../../lib/format'
import '../../features/operations/operations.css'

export const Route = createFileRoute('/_authed/operations')({
  validateSearch: operationsSearchSchema,
  component: OperationsPage,
})

const auditPageSize = 20

function OperationsPage() {
  const me = useCurrentAccount()
  const isOwner = hasRole(me, 'owner')
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const tab = currentTab(search.tab, isOwner)
  const update = (patch: Partial<OperationsSearch>, replace = true) =>
    void navigate({ search: (previous) => ({ ...previous, ...patch }), replace })

  if (!hasRole(me, 'manager', 'owner')) {
    return (
      <Page title="运营与系统">
        <Empty title="当前账号无权查看" description="报表导出与审计只对店长和老板开放，全部数据导出只对老板开放。" />
      </Page>
    )
  }

  return (
    <Page
      title="运营与系统"
      description={
        isOwner
          ? '导出经营报表、查看操作审计，下载全部数据。'
          : '导出经营报表、查看操作审计。下载全部数据只有老板可以操作。'
      }
    >
      <Tabs
        type="line"
        // 放不下（手机上）时由 Semi 自动改成左右箭头滚动，不折成两行
        collapsible="auto"
        activeKey={tab}
        tabList={operationsTabs(isOwner).map((item) => ({ itemKey: item.key, tab: item.label }))}
        onChange={(key) => update({ tab: key as OperationsTab }, false)}
      />
      <div style={{ marginTop: 16 }}>
        {tab === 'export' ? (
          <ExportPanel
            from={search.from ?? ''}
            to={search.to ?? ''}
            onRange={(from, to) => update({ from: from || undefined, to: to || undefined })}
          />
        ) : null}
        {tab === 'audit' ? (
          <AuditPanel
            keyword={search.q ?? ''}
            page={search.page ?? 1}
            onKeyword={(q) => update({ q: q || undefined, page: undefined })}
            onPage={(page) => update({ page: page > 1 ? page : undefined }, false)}
          />
        ) : null}
        {tab === 'data' && isOwner ? <DataExportPanel /> : null}
      </div>
    </Page>
  )
}

// ---------- 报表导出 ----------

function ExportPanel({ from, to, onRange }: { from: string; to: string; onRange: (from: string, to: string) => void }) {
  const today = storeToday()
  const rangeError = exportRangeError(from, to)
  const exporting = useMutation({
    mutationFn: (option: ExportOption) =>
      operationsApi.downloadExport(
        option.kind,
        option.usesDates ? { from, to } : {},
        exportFilename(option, from, to, today),
      ),
    onSuccess: (_, option) => Toast.success(`${option.label}报表已开始下载`),
  })

  return (
    <Card title="报表导出">
      <Typography.Paragraph type="tertiary" style={{ marginBottom: 12 }}>
        日期按门店日期（北京时间）计算，包含开始和结束当天；不填表示不限。文件直接下载到电脑的「下载」文件夹。
      </Typography.Paragraph>
      {/* 每个标签和它的输入框、快捷日期按钮各自成组，窄屏换行时不会把「结束日期」和它的输入框拆到两行 */}
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <span className="toolbar-field">
          <Typography.Text strong>开始日期</Typography.Text>
          <Input
            type="date"
            aria-label="开始日期"
            style={{ width: 180 }}
            value={from}
            validateStatus={rangeError ? 'error' : 'default'}
            onChange={(value) => onRange(value, to)}
          />
        </span>
        <span className="toolbar-field">
          <Typography.Text strong>结束日期</Typography.Text>
          <Input
            type="date"
            aria-label="结束日期"
            style={{ width: 180 }}
            value={to}
            validateStatus={rangeError ? 'error' : 'default'}
            onChange={(value) => onRange(from, value)}
          />
        </span>
        <span className="toolbar-field">
          {quickRanges(today).map((range) => (
            <Button key={range.label} theme="borderless" onClick={() => onRange(range.from, range.to)}>
              {range.label}
            </Button>
          ))}
          <Button theme="borderless" type="tertiary" disabled={!from && !to} onClick={() => onRange('', '')}>
            不限日期
          </Button>
        </span>
      </div>
      {rangeError ? (
        <div role="alert" style={{ marginBottom: 12 }}>
          <Typography.Text type="danger">{rangeError}，请调整日期后再导出。</Typography.Text>
        </div>
      ) : null}
      {exporting.isError ? (
        <Banner
          type="danger"
          closeIcon={null}
          description={readableError(exporting.error, '导出失败，请稍后重试')}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      <div className="operations-export-grid">
        {exportOptions.map((option) => (
          <Card key={option.kind} bodyStyle={{ padding: 16 }}>
            <Typography.Title heading={6} style={{ margin: 0 }}>
              {option.label}
            </Typography.Title>
            <Typography.Paragraph type="tertiary" size="small" style={{ margin: '4px 0 12px' }}>
              {option.hint}
            </Typography.Paragraph>
            <Button
              theme="solid"
              type="primary"
              disabled={exporting.isPending || (option.usesDates && Boolean(rangeError))}
              loading={exporting.isPending && exporting.variables?.kind === option.kind}
              onClick={() => exporting.mutate(option)}
            >
              下载{option.label} Excel
            </Button>
          </Card>
        ))}
      </div>
    </Card>
  )
}

// ---------- 审计 ----------

function AuditPanel({
  keyword,
  page,
  onKeyword,
  onPage,
}: {
  keyword: string
  page: number
  onKeyword: (keyword: string) => void
  onPage: (page: number) => void
}) {
  // 筛选、排序、分页都在服务端，只取当前这一页（审计会一直增长）
  const params = { q: keyword || undefined, actions: actionsMatching(keyword), page, pageSize: auditPageSize }
  const audit = useQuery({
    queryKey: ['system', 'audit-events', params],
    queryFn: ({ signal }) => operationsApi.listAudit(params, signal),
    placeholderData: keepPreviousData,
  })
  const [input, setInput] = useState(keyword)
  const applyKeyword = useDebouncedCallback((value: string) => onKeyword(value.trim()), { wait: 300 })

  return (
    <Card title="审计记录">
      <div className="toolbar">
        <Input
          aria-label="查找审计记录"
          prefix={<IconSearch />}
          placeholder="搜操作名、对象编号、原因或操作人"
          showClear
          style={{ maxWidth: 360 }}
          value={input}
          onChange={(value) => {
            setInput(value)
            applyKeyword(value)
          }}
        />
      </div>
      <QueryState query={audit}>
        {(current) => {
          return (
            <>
              <Typography.Text type="tertiary" size="small">
                {keyword ? `找到 ${current.total} 条` : `共 ${current.total} 条`}，最新的在前
              </Typography.Text>
              <Table
                size="small"
                rowKey="id"
                style={{ marginTop: 8 }}
                dataSource={current.rows}
                pagination={
                  current.total > auditPageSize
                    ? {
                        currentPage: current.page,
                        pageSize: auditPageSize,
                        total: current.total,
                        onPageChange: onPage,
                      }
                    : false
                }
                empty={keyword ? '没有匹配的记录，换个关键字试试' : '暂无审计记录'}
                columns={[
                  {
                    title: '时间',
                    dataIndex: 'createdAt',
                    width: 150,
                    render: (value: string) => <Nowrap>{dateTime(value)}</Nowrap>,
                  },
                  {
                    title: '操作',
                    dataIndex: 'action',
                    render: (action: string) => <Typography.Text strong>{auditName(action)}</Typography.Text>,
                  },
                  {
                    title: '原始动作',
                    dataIndex: 'action',
                    key: 'raw-action',
                    render: (action: string) => (
                      <Typography.Text type="tertiary" size="small" code>
                        {action}
                      </Typography.Text>
                    ),
                  },
                  {
                    title: '对象编号',
                    dataIndex: 'objectId',
                    width: 130,
                    render: (objectId: string | undefined) =>
                      objectId ? (
                        <Typography.Text copyable={{ content: objectId }} title={objectId}>
                          {objectId.slice(0, 8)}
                        </Typography.Text>
                      ) : (
                        '—'
                      ),
                  },
                  {
                    title: '原因',
                    dataIndex: 'reason',
                    render: (reason: string | undefined) =>
                      reason ? (
                        <Typography.Text ellipsis={{ showTooltip: true }} style={{ maxWidth: 280 }}>
                          {reason}
                        </Typography.Text>
                      ) : (
                        <Typography.Text type="quaternary">—</Typography.Text>
                      ),
                  },
                  {
                    title: '操作人',
                    dataIndex: 'accountId',
                    render: (_: unknown, row: AuditEvent) => auditActor(row),
                  },
                ]}
              />
            </>
          )
        }}
      </QueryState>
    </Card>
  )
}

// ---------- 全部数据导出（只有老板） ----------

function DataExportPanel() {
  const download = useMutation({
    mutationFn: () => operationsApi.downloadData(dataExportFilename(new Date())),
    onSuccess: () => Toast.success('数据已开始下载'),
  })
  return (
    <Card title="下载当前全部数据">
      <div className="operations-data-export">
        <Typography.Paragraph>
          一个 JSON
          文件，含全部账户（包括完整手机号）、订单、库存、会员与预约的当前数据，用于留底或交给技术人员排查，不能在后台导回。每次下载都记入审计，请妥善保管。
        </Typography.Paragraph>
        <Typography.Paragraph type="tertiary">
          数据库每天自动备份；需要把数据恢复到某个时间点时，请联系技术支持用数据库备份处理。
        </Typography.Paragraph>
        {download.isError ? (
          <Banner type="danger" closeIcon={null} description={readableError(download.error, '下载失败，请稍后重试')} />
        ) : null}
        <Button theme="solid" type="primary" loading={download.isPending} onClick={() => download.mutate()}>
          下载 JSON
        </Button>
      </div>
    </Card>
  )
}
