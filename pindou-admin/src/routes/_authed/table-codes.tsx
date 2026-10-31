import { IconPrint } from '@douyinfe/semi-icons'
import {
  Button,
  Card,
  Checkbox,
  Modal,
  Progress,
  Radio,
  RadioGroup,
  Spin,
  Table,
  Tag,
  Typography,
} from '@douyinfe/semi-ui'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { hasRole, useCurrentAccount } from '../../account'
import { codeSettingsQuery, tableCodesApi, type ServiceTable } from '../../api/table-codes'
import { Page, QueryState } from '../../components/Page'
import {
  brandLine,
  codeErrorMessage,
  codeFilename,
  dataUrlToBlob,
  generateInSequence,
  paginate,
  printItems,
  printLayouts,
  codeKinds,
  type CodeKind,
  type CodeState,
  type PerPage,
  type PrintItem,
} from '../../features/table-codes/codes'
import { groupTables, seatText, selectedTables, tableLabel, type TableGroup } from '../../features/table-codes/tables'
import { envOption } from '../../features/table-codes/code-settings'
import { webTableCode } from '../../features/table-codes/web-code'
import { saveBlob } from '../../lib/download'
import '../../features/table-codes/table-codes.css'

export const Route = createFileRoute('/_authed/table-codes')({
  component: TableCodesPage,
})

interface BatchProgress {
  total: number
  done: number
  failed: number
  running: boolean
  stopped: boolean
}

function TableCodesPage() {
  const tables = useQuery({ queryKey: ['service-tables'], queryFn: ({ signal }) => tableCodesApi.listTables(signal) })
  const areas = useQuery({ queryKey: ['floor-areas'], queryFn: ({ signal }) => tableCodesApi.listAreas(signal) })
  // 网页桌码印的地址和小程序码指向的版本都由后端给，不写死在页面里
  const settings = useQuery(codeSettingsQuery())
  const website = settings.data?.customerWebsite
  const isOwner = hasRole(useCurrentAccount(), 'owner')

  // 网页桌码不用等小程序正式版，默认出它
  const [kind, setKind] = useState<CodeKind>('web')
  // 桌码只存在这一页里：它是生成的图片，不是业务状态；实时事件让桌位重读时也不会丢。两种码各存各的
  const [codesByKind, setCodesByKind] = useState<Record<CodeKind, Record<string, CodeState>>>({ web: {}, mini: {} })
  const codes = codesByKind[kind]
  // 记「取消勾选的」而不是「勾选的」：默认全选，新读到的桌也默认在内
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set())
  const [progress, setProgress] = useState<BatchProgress | null>(null)
  const [perPage, setPerPage] = useState<PerPage>(4)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [printOnly, setPrintOnly] = useState<string | null>(null)
  const stopping = useRef(false)

  // 离开页面就不再发起新的请求
  useEffect(() => {
    stopping.current = false
    return () => {
      stopping.current = true
    }
  }, [])
  // 打印对话框关掉后恢复成「打印所选」
  useEffect(() => {
    const reset = () => setPrintOnly(null)
    window.addEventListener('afterprint', reset)
    return () => window.removeEventListener('afterprint', reset)
  }, [])

  const groups = groupTables(tables.data ?? [], areas.data ?? [])
  const ordered = groups.flatMap((group) => group.tables)
  const labels = new Map(groups.flatMap((group) => group.tables.map((table) => [table.id, tableLabel(table)])))
  const selected = selectedTables(ordered, excluded)
  const pending = selected.filter((table) => codes[table.id]?.status !== 'done')
  // 网页桌码要先读到印在码里的地址
  const waitingForWebsite = kind === 'web' && !website
  const printable = printItems(ordered, excluded, codes)
  const running = Boolean(progress?.running)
  const enabledCount = ordered.filter((table) => table.enabled).length

  // 生成中不能切换码的种类（见 RadioGroup 的 disabled），所以这里的 kind 就是开始生成时的那一种
  const setCode = (id: string, state: CodeState) =>
    setCodesByKind((previous) => ({ ...previous, [kind]: { ...previous[kind], [id]: state } }))
  const generate = (id: string) => {
    if (kind === 'mini') return tableCodesApi.tableCode(id)
    if (!website) return Promise.reject(new Error('还没读到网页桌码的地址，请刷新后重试'))
    return webTableCode(website, id)
  }
  const report = {
    onStart: (id: string) => setCode(id, { status: 'loading' }),
    onDone: (id: string, dataUrl: string) => setCode(id, { status: 'done', dataUrl }),
    onFail: (id: string, error: unknown) => setCode(id, { status: 'failed', message: codeErrorMessage(error) }),
  }

  const generateBatch = async () => {
    const ids = pending.map((table) => table.id)
    if (!ids.length || running) return
    setProgress({ total: ids.length, done: 0, failed: 0, running: true, stopped: false })
    const result = await generateInSequence(
      ids,
      generate,
      {
        ...report,
        onDone: (id, dataUrl) => {
          report.onDone(id, dataUrl)
          setProgress((previous) => previous && { ...previous, done: previous.done + 1 })
        },
        onFail: (id, error) => {
          report.onFail(id, error)
          setProgress((previous) => previous && { ...previous, failed: previous.failed + 1 })
        },
      },
      () => stopping.current,
    )
    stopping.current = false
    setProgress((previous) => previous && { ...previous, running: false, stopped: result.stopped })
  }

  const generateOne = (table: ServiceTable) => void generateInSequence([table.id], generate, report)

  const toggle = (ids: string[], include: boolean) =>
    setExcluded((previous) => {
      const next = new Set(previous)
      for (const id of ids) {
        if (include) next.delete(id)
        else next.add(id)
      }
      return next
    })

  const printSelected = () => {
    flushSync(() => setPrintOnly(null))
    window.print()
  }
  const printSingle = (id: string) => {
    // 先关预览、换成单张版式，再打开打印对话框
    flushSync(() => {
      setPreviewId(null)
      setPrintOnly(id)
    })
    window.print()
  }

  const sheetItems = printOnly ? printItems(ordered, excluded, codes, printOnly) : printable
  const sheetPerPage: PerPage = printOnly ? 1 : perPage
  const previewCode = previewId ? codes[previewId] : undefined
  const previewLabel = previewId ? (labels.get(previewId) ?? '') : ''

  return (
    <div className="table-codes-page">
      <Page
        title="桌码"
        description={`网页桌码是普通二维码（${website ?? '网页桌码地址'}/t?tableId=…），顾客用微信「扫一扫」直接进小程序这张桌的入座页（用手机相机扫只会看到一页「请用微信扫码」），在浏览器里就能生成；小程序码指向的小程序版本由老板在「系统设置」里定，体验版只有体验成员能打开。可以逐张生成预览、下载，也可以成批生成后直接打印贴到桌上。停用的桌不出码。`}
      >
        <div className="no-print">
          <QueryState query={tables}>
            {() => (
              <>
                <Card title="批量生成与打印" style={{ marginBottom: 16 }}>
                  <div className="toolbar">
                    <Typography.Text strong>桌码类型</Typography.Text>
                    {/* 两组单选各起名字：Semi 默认都叫 default，浏览器会把它们当成同一组，选一个就把另一组的勾去掉 */}
                    <RadioGroup
                      type="button"
                      name="table-code-kind"
                      value={kind}
                      disabled={running}
                      onChange={(event) => setKind(event.target.value as CodeKind)}
                    >
                      {codeKinds.map((option) => (
                        <Radio key={option.kind} value={option.kind}>
                          {option.label}
                        </Radio>
                      ))}
                    </RadioGroup>
                    {kind === 'mini' && settings.data ? (
                      <Typography.Text type="secondary">
                        指向{envOption(settings.data.envVersion).label}
                        {isOwner ? (
                          <>
                            （在
                            <Link to="/system-settings" search={{ tab: 'code' }}>
                              系统设置
                            </Link>
                            里改）
                          </>
                        ) : (
                          '（老板在系统设置里改）'
                        )}
                      </Typography.Text>
                    ) : null}
                    {waitingForWebsite && settings.isError ? (
                      <Typography.Text type="danger">
                        没读到网页桌码的地址，生成不了网页桌码，请刷新页面
                      </Typography.Text>
                    ) : null}
                  </div>
                  <div className="toolbar">
                    <Typography.Text>
                      已选 {selected.length} 张（启用 {enabledCount} 张，共 {ordered.length} 张）
                    </Typography.Text>
                    <Button
                      theme="borderless"
                      disabled={running}
                      onClick={() =>
                        toggle(
                          ordered.map((table) => table.id),
                          true,
                        )
                      }
                    >
                      全选
                    </Button>
                    <Button
                      theme="borderless"
                      type="tertiary"
                      disabled={running}
                      onClick={() =>
                        toggle(
                          ordered.map((table) => table.id),
                          false,
                        )
                      }
                    >
                      全不选
                    </Button>
                  </div>
                  <div className="toolbar">
                    {running ? (
                      <Button type="danger" onClick={() => (stopping.current = true)}>
                        停止生成
                      </Button>
                    ) : (
                      <Button
                        theme="solid"
                        type="primary"
                        disabled={!pending.length || waitingForWebsite}
                        onClick={() => void generateBatch()}
                      >
                        {pending.length || !selected.length
                          ? `生成所选桌码（${pending.length} 张）`
                          : '所选桌码都已生成'}
                      </Button>
                    )}
                    <Typography.Text strong>打印版式</Typography.Text>
                    <RadioGroup
                      type="button"
                      name="table-code-layout"
                      value={perPage}
                      onChange={(event) => setPerPage(event.target.value as PerPage)}
                    >
                      {printLayouts.map((layout) => (
                        <Radio key={layout.perPage} value={layout.perPage}>
                          {layout.label}
                        </Radio>
                      ))}
                    </RadioGroup>
                    <Button icon={<IconPrint />} disabled={!printable.length || running} onClick={printSelected}>
                      打印所选（{printable.length} 张）
                    </Button>
                  </div>
                  {progress ? <BatchStatus progress={progress} /> : null}
                  {!running && printable.length > 0 && printable.length < selected.length ? (
                    <Typography.Text type="warning" size="small">
                      所选的桌里还有 {selected.length - printable.length} 张没有生成成功的桌码，打印时不会包含它们。
                    </Typography.Text>
                  ) : null}
                </Card>
                {groups.map((group) => (
                  <ZoneCard
                    key={group.key}
                    group={group}
                    codes={codes}
                    excluded={excluded}
                    running={running}
                    onToggle={toggle}
                    onGenerate={generateOne}
                    onPreview={setPreviewId}
                  />
                ))}
                {!groups.length ? <Typography.Text type="tertiary">门店还没有桌位。</Typography.Text> : null}
              </>
            )}
          </QueryState>
        </div>

        <PrintSheets items={sheetItems} perPage={sheetPerPage} />

        <Modal
          title={`桌码 · ${previewLabel}`}
          visible={Boolean(previewId && previewCode?.status === 'done')}
          onCancel={() => setPreviewId(null)}
          footer={
            previewId && previewCode?.status === 'done' ? (
              <>
                <Button
                  onClick={() =>
                    saveBlob(dataUrlToBlob(previewCode.dataUrl), codeFilename(previewLabel, previewCode.dataUrl))
                  }
                >
                  下载图片
                </Button>
                <Button icon={<IconPrint />} onClick={() => printSingle(previewId)}>
                  只打印这一张
                </Button>
                <Button theme="solid" type="primary" onClick={() => setPreviewId(null)}>
                  关闭
                </Button>
              </>
            ) : null
          }
        >
          {previewCode?.status === 'done' ? (
            <figure className="table-code-preview">
              <img src={previewCode.dataUrl} alt={`${previewLabel} 桌码`} />
              <figcaption>
                <Typography.Title heading={3} style={{ margin: 0 }}>
                  {previewLabel}
                </Typography.Title>
                <Typography.Text type="tertiary">{brandLine}</Typography.Text>
              </figcaption>
            </figure>
          ) : null}
        </Modal>
      </Page>
    </div>
  )
}

function BatchStatus({ progress }: { progress: BatchProgress }) {
  const finished = progress.done + progress.failed
  const percent = progress.total ? Math.round((finished / progress.total) * 100) : 0
  const text = progress.running
    ? `正在生成 ${finished} / ${progress.total}${progress.failed ? `，失败 ${progress.failed} 张` : ''}`
    : `${progress.stopped ? '已停止' : '生成完成'}：成功 ${progress.done} 张${
        progress.failed ? `，失败 ${progress.failed} 张（下面标红的桌可单独重试）` : ''
      }${progress.stopped ? `，还有 ${progress.total - finished} 张没有生成` : ''}`
  return (
    <div className="table-codes-progress" role="status">
      <Progress
        percent={percent}
        stroke={progress.failed ? 'var(--semi-color-warning)' : undefined}
        aria-label="桌码生成进度"
        style={{ height: 8 }}
      />
      <Typography.Text type={progress.failed ? 'warning' : 'secondary'}>{text}</Typography.Text>
    </div>
  )
}

function ZoneCard({
  group,
  codes,
  excluded,
  running,
  onToggle,
  onGenerate,
  onPreview,
}: {
  group: TableGroup
  codes: Record<string, CodeState>
  excluded: ReadonlySet<string>
  running: boolean
  onToggle: (ids: string[], include: boolean) => void
  onGenerate: (table: ServiceTable) => void
  onPreview: (id: string) => void
}) {
  const enabled = group.tables.filter((table) => table.enabled)
  const chosen = enabled.filter((table) => !excluded.has(table.id)).length
  return (
    <Card
      title={group.title}
      style={{ marginBottom: 16 }}
      headerExtraContent={
        enabled.length ? (
          <Checkbox
            checked={chosen === enabled.length}
            indeterminate={chosen > 0 && chosen < enabled.length}
            disabled={running}
            onChange={(event) =>
              onToggle(
                enabled.map((table) => table.id),
                Boolean(event.target.checked),
              )
            }
          >
            选中本区
          </Checkbox>
        ) : null
      }
    >
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={group.tables}
        columns={[
          {
            title: '',
            width: 48,
            render: (_: unknown, table: ServiceTable) =>
              table.enabled ? (
                <Checkbox
                  aria-label={`选择 ${tableLabel(table)}`}
                  checked={!excluded.has(table.id)}
                  disabled={running}
                  onChange={(event) => onToggle([table.id], Boolean(event.target.checked))}
                />
              ) : null,
          },
          {
            title: '桌号',
            width: 100,
            render: (_: unknown, table: ServiceTable) => <Typography.Text strong>{tableLabel(table)}</Typography.Text>,
          },
          { title: '座位', width: 120, render: (_: unknown, table: ServiceTable) => seatText(table) },
          {
            title: '状态',
            width: 100,
            render: (_: unknown, table: ServiceTable) =>
              table.enabled ? <Tag color="green">启用</Tag> : <Tag color="grey">已停用</Tag>,
          },
          {
            title: '桌码',
            render: (_: unknown, table: ServiceTable) => (
              <CodeCell table={table} code={codes[table.id]} onPreview={() => onPreview(table.id)} />
            ),
          },
          {
            title: '',
            width: 120,
            render: (_: unknown, table: ServiceTable) => {
              if (!table.enabled) return null
              const code = codes[table.id]
              return (
                <Button
                  size="small"
                  theme="borderless"
                  disabled={running || code?.status === 'loading'}
                  onClick={() => onGenerate(table)}
                >
                  {code?.status === 'done' ? '重新生成' : code?.status === 'failed' ? '重试' : '生成'}
                </Button>
              )
            },
          },
        ]}
      />
    </Card>
  )
}

function CodeCell({ table, code, onPreview }: { table: ServiceTable; code?: CodeState; onPreview: () => void }) {
  if (!table.enabled) return <Typography.Text type="tertiary">停用的桌不出码</Typography.Text>
  if (!code) return <Typography.Text type="tertiary">未生成</Typography.Text>
  if (code.status === 'loading')
    return (
      <span className="table-code-cell">
        <Spin size="small" />
        <Typography.Text type="tertiary">生成中</Typography.Text>
      </span>
    )
  if (code.status === 'failed') return <Typography.Text type="danger">失败：{code.message}</Typography.Text>
  return (
    <button type="button" className="table-code-thumb" title="点击预览" onClick={onPreview}>
      <img src={code.dataUrl} alt={`${tableLabel(table)} 桌码`} />
      <Typography.Text link>预览</Typography.Text>
    </button>
  )
}

/** 打印用的版面：屏幕上不显示，打印时只剩它（侧栏、顶栏、操作区都隐藏）。 */
function PrintSheets({ items, perPage }: { items: PrintItem[]; perPage: PerPage }) {
  return (
    <div className={`table-code-sheets table-code-per-page-${perPage}`} data-testid="table-code-sheets">
      {paginate(items, perPage).map((sheet, index) => (
        <section className="table-code-sheet" key={index}>
          {sheet.map((item) => (
            <figure className="table-code-card" key={item.id}>
              <img src={item.dataUrl} alt={`${item.label} 桌码`} />
              <figcaption>
                <div className="table-code-label">{item.label}</div>
                <div className="table-code-brand">{brandLine}</div>
              </figcaption>
            </figure>
          ))}
        </section>
      ))}
    </div>
  )
}
