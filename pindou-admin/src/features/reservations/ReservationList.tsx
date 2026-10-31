import {
  Banner,
  Button,
  DatePicker,
  Descriptions,
  Radio,
  RadioGroup,
  SideSheet,
  Space,
  Table,
  Tag,
  Typography,
} from '@douyinfe/semi-ui'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { useId, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { isPreviousApplied } from '../../api/client'
import {
  endedPageSize,
  endedReservationsQuery,
  reservationsApi,
  type ReservationEntry,
  type ReservationView,
} from '../../api/reservations'
import { Nowrap } from '../../components/Nowrap'
import { QueryState } from '../../components/Page'
import { useSheetFocus } from '../../components/useSheetFocus'
import { useBillingEnabled } from '../../api/billing'
import { couponText } from '../../lib/coupon'
import { dateOnly, dateTime } from '../../lib/format'
import { lateMinutes } from '../board/board'
import { useBoardAction } from '../board/useBoardAction'
import {
  addDays,
  amountText,
  canCancel,
  canConfirm,
  canMarkNoShow,
  canSeat,
  customerText,
  dayText,
  listViews,
  openEntries,
  packageText,
  placeText,
  sourceText,
  statusColors,
  statusNames,
  viewCounts,
  viewNames,
  whenText,
  type ListView,
} from './reservations'
import { useArrivalSeating } from './useArrivalSeating'
import { useReasonDialog } from './useReasonDialog'

const route = getRouteApi('/_authed/reservations')

/** 一行上能点的操作。只决定显示，能不能做以后端为准。 */
interface RowHandlers {
  busy: boolean
  now: number
  confirm: (entry: ReservationEntry) => void
  seat: (entry: ReservationEntry) => void
  cancel: (entry: ReservationEntry) => void
  noShow: (entry: ReservationEntry) => void
}

/** 抽屉对应的预约：开着时跟着最新数据走；数据里没有了（刚被处理、翻页）就留着最后看到的样子。 */
interface DetailTarget {
  id: string
  visible: boolean
  last: ReservationEntry
}

/**
 * 预约列表（同小程序员工「预约 › 预约列表」）：还要处理的（待确认、待到店、过了时间没处理的）整份取回，
 * 按门店日期与状态在本页筛；处理完的（已到店、已取消、爽约）服务端分页，门店日期带给后端筛（哪一天按中国标准时间，
 * 由后端判断）。两部分共用网址里的同一个日期。每行能确认、到店开台、取消、标记爽约，
 * 点一行看详情。状态（含过期）以接口为准，实时事件到达随全部查询重读。
 */
export function ReservationList({ view, now }: { view: ReservationView; now: number }) {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const current: ListView = search.view ?? 'open'
  const ended = useQuery(endedReservationsQuery(search.page ?? 1, search.date))
  const tables = useMemo(() => new Map(view.tables.map((table) => [table.id, table])), [view.tables])
  const placeOf = (entry: ReservationEntry) => placeText(entry, tables)
  const billing = useBillingEnabled()

  // 确认、直接开台的请求共用一份，失败原因写在表格上方；取消、爽约和散客开台的失败原因写在各自的弹窗里
  const action = useBoardAction()
  const seating = useArrivalSeating({ action, packages: view.packages, placeOf, now })
  const reason = useReasonDialog({ placeOf })
  const handlers: RowHandlers = {
    busy: action.isPending,
    now,
    confirm: (entry) =>
      action.mutate({
        run: () => reservationsApi.act({ action: 'confirm', targetId: entry.reservation.id }),
        done: '预约已确认',
      }),
    seat: seating.start,
    cancel: (entry) => reason.ask(entry, 'cancel'),
    noShow: (entry) => reason.ask(entry, 'no_show'),
  }

  const [detail, setDetail] = useState<DetailTarget | null>(null)
  const openDetail = (entry: ReservationEntry) => setDetail({ id: entry.reservation.id, visible: true, last: entry })
  // 详情跟着最新数据走：还要处理的里有就用它，处理完了而这一页已结束的列表里有就用那条；都没有（刚处理、不在这一页）
  // 就留着最后看到的样子，并说明已被处理
  const inOpen = detail ? view.reservations.find((entry) => entry.reservation.id === detail.id) : undefined
  const inEnded = detail ? ended.data?.rows.find((entry) => entry.reservation.id === detail.id) : undefined
  const latest = detail ? (inOpen ?? inEnded ?? detail.last) : null

  const counts = viewCounts(view.reservations, search.date)
  const today = dateOnly(now)
  const setView = (next: ListView) =>
    void navigate({ search: (prev) => ({ ...prev, view: next === 'open' ? undefined : next, page: undefined }) })
  // 换日期回到已结束的第 1 页（别的日子的页码对这一天没意义）
  const setDate = (date: string | undefined) =>
    void navigate({ search: (prev) => ({ ...prev, date, page: undefined }) })

  const columns = tableColumns({ placeOf, handlers, onDetail: openDetail, billing })

  return (
    <div className="reservation-list">
      <div className="toolbar">
        <RadioGroup
          type="button"
          name="reservation-view"
          aria-label="看哪些预约"
          className="reservation-views"
          value={current}
          onChange={(event) => setView(event.target.value as ListView)}
        >
          {listViews.map((key) => (
            <Radio key={key} value={key}>
              {viewNames[key]}
              {key === 'ended' ? (ended.data ? ` ${ended.data.total}` : '') : ` ${counts[key]}`}
            </Radio>
          ))}
        </RadioGroup>
        <DateFilter date={search.date} today={today} ended={current === 'ended'} onChange={setDate} />
      </div>

      {action.error ? (
        <Banner
          type={isPreviousApplied(action.error) ? 'warning' : 'danger'}
          closeIcon={null}
          description={action.error.message}
          style={{ marginBottom: 12 }}
        />
      ) : null}

      {current === 'ended' ? (
        <QueryState query={ended}>
          {({ rows, total, page }) => (
            <>
              <Typography.Text type="tertiary" style={{ display: 'block', marginBottom: 8 }}>
                {search.date ? `${dayText(search.date, today)}，` : '全部日期，'}
                已到店、已取消和爽约的共 {total} 条，按到店时间从新到旧。
              </Typography.Text>
              <Table
                size="small"
                rowKey={(row?: ReservationEntry) => row?.reservation.id ?? ''}
                dataSource={rows}
                columns={columns}
                empty={search.date ? `${dayText(search.date, today)} 没有已结束的预约。` : '还没有已结束的预约记录。'}
                onRow={rowProps(openDetail)}
                pagination={
                  total > endedPageSize
                    ? {
                        pageSize: endedPageSize,
                        total,
                        currentPage: page,
                        onPageChange: (next) =>
                          void navigate({ search: (prev) => ({ ...prev, page: next > 1 ? next : undefined }) }),
                      }
                    : false
                }
              />
            </>
          )}
        </QueryState>
      ) : (
        <>
          <Typography.Text type="tertiary" style={{ display: 'block', marginBottom: 8 }}>
            {search.date ? `${dayText(search.date, today)}，` : '全部日期，'}
            按到店时间从早到晚。待确认的是顾客在小程序自助提交的，确认后才算生效。
          </Typography.Text>
          <Table
            size="small"
            rowKey={(row?: ReservationEntry) => row?.reservation.id ?? ''}
            dataSource={openEntries(view.reservations, current, search.date)}
            columns={columns}
            pagination={false}
            empty={emptyText(current, search.date, today)}
            onRow={rowProps(openDetail)}
          />
        </>
      )}

      <DetailSheet
        entry={latest}
        visible={Boolean(detail?.visible && latest)}
        handled={Boolean(detail && !inOpen && !inEnded && canCancel(detail.last))}
        placeOf={placeOf}
        handlers={handlers}
        graceMinutes={view.settings.graceMinutes}
        onClose={() =>
          setDetail((target) => (target ? { ...target, visible: false, last: latest ?? target.last } : null))
        }
        afterClose={() => setDetail((target) => (target?.visible ? target : null))}
      />
      {seating.dialog}
      {reason.dialog}
    </div>
  )
}

/** 点一行看详情（行里的按钮自己拦住点击，不会顺带打开）。 */
const rowProps = (open: (entry: ReservationEntry) => void) => (row?: ReservationEntry) => ({
  onClick: () => {
    if (row) open(row)
  },
  style: { cursor: 'pointer' },
  'data-reservation': row?.reservation.id,
})

function emptyText(current: Exclude<ListView, 'ended'>, date: string | undefined, today: string): string {
  const when = date ? `${dayText(date, today)} ` : ''
  switch (current) {
    case 'pending':
      return `${when}没有等待确认的预约。`
    case 'confirmed':
      return `${when}没有已确认待到店的预约。`
    case 'expired':
      return `${when}没有过了时间还没处理的预约。`
    default:
      return `${when}没有要处理的预约。`
  }
}

/**
 * 门店日期筛选：日期选择器的触发框读屏名是英文（Semi 写死），标题挂在外层这一组上。清空就是全部日期。
 * 还要处理的多是今天往后，快捷选项给今天、明天；已结束的多是往前看，给今天、昨天。
 */
function DateFilter({
  date,
  today,
  ended,
  onChange,
}: {
  date: string | undefined
  today: string
  ended: boolean
  onChange: (date: string | undefined) => void
}) {
  const other = ended ? { text: '昨天', day: addDays(today, -1) } : { text: '明天', day: addDays(today, 1) }
  const id = useId()
  return (
    <span className="toolbar-field" role="group" aria-labelledby={id}>
      <Typography.Text id={id}>到店日期</Typography.Text>
      <DatePicker
        type="date"
        format="yyyy-MM-dd"
        placeholder="全部日期"
        style={{ width: 160 }}
        value={date}
        presets={[
          { text: '今天', start: today, end: today },
          { text: other.text, start: other.day, end: other.day },
        ]}
        onChange={(_, text) => onChange(typeof text === 'string' && text ? text : undefined)}
      />
      {date !== today ? (
        <Button theme="borderless" onClick={() => onChange(today)}>
          只看今天
        </Button>
      ) : null}
    </span>
  )
}

/** 状态：标签，过了开始时间还没到店的写过了多久，过期的写座位已释放。 */
function StatusCell({ entry, now }: { entry: ReservationEntry; now: number }) {
  const late = entry.displayStatus === 'pending' || entry.displayStatus === 'confirmed' ? lateMinutes(entry, now) : 0
  return (
    <div className="reservation-cell">
      <Tag color={statusColors[entry.displayStatus]}>{statusNames[entry.displayStatus]}</Tag>
      {late > 0 ? (
        <Typography.Text type="warning" size="small">
          <Nowrap>已过开始 {late} 分钟</Nowrap>
        </Typography.Text>
      ) : null}
      {entry.displayStatus === 'expired' ? (
        <Typography.Text type="danger" size="small">
          <Nowrap>座位已释放</Nowrap>
        </Typography.Text>
      ) : null}
    </div>
  )
}

/** 一行的操作按钮：确认预约（待确认）、到店开台（待确认、已确认）、取消、爽约（到了开始时间）。点按钮不打开详情。 */
function RowActions({
  entry,
  handlers,
  onDetail,
  wrap = false,
}: {
  entry: ReservationEntry
  handlers: RowHandlers
  onDetail?: (entry: ReservationEntry) => void
  /** 详情抽屉里窄，按钮放不下就换行；表格里排成一行，表格放不下自己左右滑。 */
  wrap?: boolean
}) {
  const { busy, now } = handlers
  const click = (run: (entry: ReservationEntry) => void) => (event: MouseEvent) => {
    event.stopPropagation()
    run(entry)
  }
  return (
    <Space spacing={4} wrap={wrap}>
      {canConfirm(entry) ? (
        <Button size="small" theme="solid" disabled={busy} onClick={click(handlers.confirm)}>
          确认预约
        </Button>
      ) : null}
      {canSeat(entry) ? (
        <Button size="small" theme="solid" disabled={busy} onClick={click(handlers.seat)}>
          到店开台
        </Button>
      ) : null}
      {canCancel(entry) ? (
        <Button size="small" disabled={busy} onClick={click(handlers.cancel)}>
          取消预约
        </Button>
      ) : null}
      {canMarkNoShow(entry, now) ? (
        <Button size="small" type="danger" disabled={busy} onClick={click(handlers.noShow)}>
          标记爽约
        </Button>
      ) : null}
      {onDetail ? (
        <Button size="small" theme="borderless" onClick={click(onDetail)}>
          详情
        </Button>
      ) : null}
    </Space>
  )
}

/**
 * 表格的列：到店时间、座位、顾客、套餐（团购记录；系统内收费开着时还有到店应收）、状态、备注与处理原因、操作。
 * 还要处理的和已结束的共用。
 */
function tableColumns({
  placeOf,
  handlers,
  onDetail,
  billing,
}: {
  placeOf: (entry: ReservationEntry) => string
  handlers: RowHandlers
  onDetail: (entry: ReservationEntry) => void
  billing: boolean
}) {
  return [
    {
      title: '到店时间',
      render: (_: unknown, row: ReservationEntry) => <Nowrap>{whenText(row)}</Nowrap>,
    },
    { title: '座位', render: (_: unknown, row: ReservationEntry) => <Nowrap>{placeOf(row)}</Nowrap> },
    { title: '顾客', render: (_: unknown, row: ReservationEntry) => customerText(row) },
    {
      title: '套餐',
      render: (_: unknown, row: ReservationEntry) => (
        <div className="reservation-cell cell-wide">
          <span>{packageText(row)}</span>
          {row.reservation.coupon ? (
            <Typography.Text type="tertiary" size="small">
              团购：{couponText(row.reservation.coupon)}
            </Typography.Text>
          ) : null}
          {billing ? (
            <Typography.Text type="tertiary" size="small">
              到店应收 {amountText(row)}
            </Typography.Text>
          ) : null}
        </div>
      ),
    },
    {
      title: '状态',
      render: (_: unknown, row: ReservationEntry) => <StatusCell entry={row} now={handlers.now} />,
    },
    {
      title: '备注',
      render: (_: unknown, row: ReservationEntry) => <NotesCell entry={row} />,
    },
    {
      title: '操作',
      render: (_: unknown, row: ReservationEntry) => <RowActions entry={row} handlers={handlers} onDetail={onDetail} />,
    },
  ]
}

function NotesCell({ entry }: { entry: ReservationEntry }) {
  const { note, reason } = entry.reservation
  if (!note && !reason) return <Typography.Text type="quaternary">—</Typography.Text>
  return (
    <div className="reservation-cell cell-wide">
      {note ? <span>{note}</span> : null}
      {reason ? (
        <Typography.Text type="tertiary" size="small">
          处理原因：{reason}
        </Typography.Text>
      ) : null}
    </div>
  )
}

/** 预约详情：预约时记下的全部内容、怎么登记的、什么时候登记和处理的；还要处理的在下面直接操作。 */
function DetailSheet({
  entry,
  visible,
  handled,
  placeOf,
  handlers,
  graceMinutes,
  onClose,
  afterClose,
}: {
  entry: ReservationEntry | null
  visible: boolean
  /** 打开后被处理掉了（不在待处理里了），这里显示的是最后看到的样子。 */
  handled: boolean
  placeOf: (entry: ReservationEntry) => string
  handlers: RowHandlers
  graceMinutes: number
  onClose: () => void
  afterClose: () => void
}) {
  const title = '预约详情'
  const focus = useSheetFocus(visible, { className: 'reservation-sheet', label: title })
  return (
    <SideSheet
      className="reservation-sheet"
      visible={visible}
      title={title}
      width={460}
      onCancel={onClose}
      closeOnEsc
      afterVisibleChange={(shown) => {
        focus(shown)
        if (!shown) afterClose()
      }}
    >
      {entry ? (
        <DetailBody entry={entry} handled={handled} placeOf={placeOf} handlers={handlers} graceMinutes={graceMinutes} />
      ) : null}
    </SideSheet>
  )
}

function DetailBody({
  entry,
  handled,
  placeOf,
  handlers,
  graceMinutes,
}: {
  entry: ReservationEntry
  handled: boolean
  placeOf: (entry: ReservationEntry) => string
  handlers: RowHandlers
  graceMinutes: number
}) {
  const x = entry.reservation
  const billing = useBillingEnabled()
  const rows: { key: string; value: ReactNode }[] = [
    { key: '状态', value: <StatusCell entry={entry} now={handlers.now} /> },
    { key: '到店时间', value: whenText(entry) },
    { key: '座位', value: placeOf(entry) },
    { key: '顾客', value: customerText(entry) },
    { key: '套餐', value: `${packageText(entry)}（预约时）` },
    ...(x.coupon ? [{ key: '团购', value: couponText(x.coupon) }] : []),
    ...(billing ? [{ key: '到店应收', value: amountText(entry) }] : []),
    { key: '备注', value: x.note || '—' },
    ...(x.reason ? [{ key: '处理原因', value: x.reason }] : []),
    { key: '登记方式', value: sourceText(entry) },
    { key: '登记时间', value: dateTime(x.createdAt) },
    ...(x.decidedAt ? [{ key: '处理时间', value: dateTime(x.decidedAt) }] : []),
    { key: '预约编号', value: x.id.slice(0, 8) },
  ]
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {handled ? (
        <Banner
          type="info"
          closeIcon={null}
          description="这条预约刚被处理过（这台电脑或别处），下面是处理前看到的内容；最新状态见「已结束」。"
        />
      ) : null}
      {entry.displayStatus === 'expired' ? (
        <Banner
          type="warning"
          closeIcon={null}
          description={`已超过到店时间加 ${graceMinutes} 分钟宽限，座位已释放；请标记爽约或取消。`}
        />
      ) : null}
      <Descriptions align="left" data={rows} />
      <Typography.Text type="tertiary" size="small">
        {billing
          ? '到店开台按当时现行的套餐计时计价，预约时记下的套餐和价格只作参考。'
          : '到店开台按当时现行的套餐计时，预约时记下的套餐只作参考。团购请在美团开店宝验券，系统只记下来。'}
      </Typography.Text>
      {handled ? null : <RowActions entry={entry} handlers={handlers} wrap />}
    </div>
  )
}
