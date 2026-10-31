import { Banner, Button, Divider, Typography } from '@douyinfe/semi-ui'
import { useMemo, useState } from 'react'
import { boardApi, type BoardData, type VenueSession } from '../../api/board'
import { isPreviousApplied } from '../../api/client'
import { confirmDialog } from '../../components/confirm'
import { Field } from '../../components/Field'
import { NamedSelect } from '../../components/NamedSelect'
import type { BoardSeat, SessionActions } from './board'
import { moveOption, moveTargets } from './move'
import { bookingText, tableBookings } from './open'
import type { useBoardAction } from './useBoardAction'

type Running = 'move' | 'companion' | 'cancel'

/**
 * 会话详情里不常用的操作：换桌（整桌会话）或换座（按座会话）、标记陪客、撤销误开。
 * 行为、前置条件与确认照小程序员工端：
 * - 换桌、换座：选好目标再点确认，不另弹确认框（小程序也不弹）；整桌会话走 PATCH /venue-sessions（带幂等键），
 *   按座会话走 /loyalty/actions 的 move，带读到的 sessionVersion 和目标座号；
 * - 陪客：只有整桌会话有，先确认（写清后果：不计时、不能暂停或继续、改不回，标错只能撤销重开；小程序同样先问），
 *   标了不能改回；
 * - 撤销开台：只有整桌会话有，先确认（危险样式，写清后果），DELETE /venue-sessions。
 * 都不做乐观更新：成功后看板随全部查询重读，换走、撤销了的会话这个座位上就没有了，抽屉关掉。
 * 失败时后端的原话显示在这一段里；结果未知时 api/client 的 idempotentFetch 记下原请求，再点同一按钮先原样重发。
 */
export function SessionMore({
  seat,
  session,
  actions,
  data,
  version,
  now,
  busy,
  task,
  error,
  onClose,
}: {
  seat: BoardSeat
  session: VenueSession
  actions: SessionActions
  data: BoardData
  /** 按座会话读到的 sessionVersion（换座要带）。 */
  version: string
  now: number
  /** 抽屉里别的操作正在进行。 */
  busy: boolean
  /** 这一段的写操作（和计时那几个分开，错误显示在这里）。 */
  task: ReturnType<typeof useBoardAction>
  /** 这一段最近一次操作的错误；别处的操作更晚时由调用方给 null。 */
  error: Error | null
  onClose: () => void
}) {
  const [target, setTarget] = useState<string | undefined>(undefined)
  const [running, setRunning] = useState<Running | null>(null)
  // 候选只随读到的数据变（不随每秒的倒数变）：Semi 每次渲染都深比较 optionList，内容没变别给新对象
  const targets = useMemo(() => moveTargets(data, session), [data, session])
  const options = useMemo(() => targets.map(moveOption), [targets])
  // 选好的目标重读后被人占了：值留着（下拉框里写着为什么不能选），确认按钮点不动
  const chosen = targets.find((item) => item.value === target && !item.blocked)
  const bookings = chosen ? tableBookings(data.reservations, chosen.serviceTableId, now) : []
  const seatMove = actions.move === 'seat'
  const noun = seatMove ? '换座' : '换桌'
  const pending = task.isPending
  const disabled = busy || pending

  const run = (kind: Running, ...args: Parameters<typeof task.mutate>) => {
    setRunning(kind)
    task.mutate(...args)
  }

  const move = () => {
    if (!chosen) return
    const done = `${seat.code} 已换到 ${chosen.place}`
    const expectedVersion = version
    run(
      'move',
      {
        run: () =>
          seatMove
            ? boardApi.loyalty({
                action: 'move',
                targetId: session.id,
                expectedVersion,
                serviceTableId: chosen.serviceTableId,
                seatNumber: chosen.seatNumber ?? 1,
              })
            : boardApi.updateSession(session.id, { serviceTableId: chosen.serviceTableId }),
        done,
      },
      // 会话换走了，这个座位上不再有它：关掉抽屉，看平面图上的新位置
      { onSuccess: onClose },
    )
  }

  // 陪客标了就改不回（陪客会话不能再暂停、继续），标错只能撤销开台后重开：先确认，写清后果。
  // 确认按钮是危险样式（不能撤回的操作），打开时焦点在「取消」上，误按回车不会标。
  const markCompanion = () => {
    void confirmDialog({
      title: '标记陪客',
      content: (
        <div style={{ display: 'grid', gap: 4 }}>
          <div>{seat.code} 标记为陪客后：</div>
          <div>{actions.end ? '· 不计时；' : '· 不计时，不收计时费；'}</div>
          <div>· 不能再暂停或继续；</div>
          <div>· 改不回普通计时。标错了只能撤销开台后重开。</div>
        </div>
      ),
      okText: '标记为陪客',
      okType: 'danger',
    }).then((ok) => {
      if (!ok) return
      run('companion', {
        run: () => boardApi.updateSession(session.id, { status: 'companion' }),
        done: `${seat.code} 已标记陪客`,
      })
    })
  }

  const cancel = () => {
    void confirmDialog({
      title: '撤销开台',
      content: (
        <div style={{ display: 'grid', gap: 4 }}>
          <div>{seat.code} 这一台撤销后：</div>
          <div>{actions.end ? '· 计时作废，座位空出来；' : '· 计时作废，不收计时费，座位空出来；'}</div>
          <div>· 这一台已建好的待结账订单（如有）一并作废，订单显示「已撤销」；</div>
          <div>
            {actions.end
              ? '· 撤销不能恢复。只用于误开，顾客实际用过的请点「结束」。'
              : '· 撤销不能恢复。只用于误开，顾客实际用过的请去结账。'}
          </div>
        </div>
      ),
      okText: '确认撤销',
      okType: 'danger',
    }).then((ok) => {
      if (!ok) return
      run(
        'cancel',
        { run: () => boardApi.cancelSession(session.id), done: `${seat.code} 已撤销开台` },
        { onSuccess: onClose },
      )
    })
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Divider margin={4} />
      {/* 上一次没收到结果的操作其实已经生效（这次没提交）：不是失败，用提醒的样子 */}
      {error ? (
        <Banner type={isPreviousApplied(error) ? 'warning' : 'danger'} closeIcon={null} description={error.message} />
      ) : null}

      {/* compact：段与段的间距交给外层的 grid，字段自己不再留下边距 */}
      <Field
        label={noun}
        labelMode="labelledby"
        compact
        help={
          seatMove
            ? '只能选空座位，有人或停用的灰着并写明原因。计时和套餐照旧，只换位置。'
            : '只能选空闲、启用的桌，有人或停用的灰着并写明原因。整台连同计时一起换过去。'
        }
      >
        {(control) => (
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <NamedSelect
                {...control}
                label={noun}
                style={{ width: '100%' }}
                placeholder={seatMove ? '选择空座位' : '选择空闲的桌'}
                disabled={disabled || (seatMove && actions.waiting)}
                value={target}
                optionList={options}
                onChange={(value) => setTarget(typeof value === 'string' ? value : undefined)}
              />
            </div>
            <Button
              loading={pending && running === 'move'}
              disabled={disabled || !chosen || (seatMove && actions.waiting)}
              onClick={move}
            >
              确认{noun}
            </Button>
          </div>
        )}
      </Field>
      {bookings.length ? (
        <Banner
          type="warning"
          closeIcon={null}
          description={
            <div>
              <div>{chosen?.place} 今天还有预约：</div>
              {bookings.map((entry) => (
                <div key={entry.reservation.id}>{bookingText(entry)}</div>
              ))}
              <div>换过去的时段压到预约时系统会拒绝，请先处理预约或另选一处。</div>
            </div>
          }
        />
      ) : null}

      {actions.companion ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <Typography.Text strong>陪客</Typography.Text>
          <Typography.Text type="tertiary" size="small">
            陪客不计时，标记后不能再暂停或继续；标错了只能撤销开台后重开。
          </Typography.Text>
          <div>
            <Button
              loading={pending && running === 'companion'}
              disabled={disabled || actions.companion === 'marked'}
              onClick={markCompanion}
            >
              {actions.companion === 'marked' ? '已标记陪客' : '标记陪客'}
            </Button>
          </div>
        </div>
      ) : null}

      {actions.cancel ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <Typography.Text strong>撤销开台</Typography.Text>
          <Typography.Text type="tertiary" size="small">
            {actions.end
              ? '仅用于误开，顾客实际用过的请点上面的「结束」。'
              : '仅用于误开的未结账会话，实际消费请核对订单并结账。'}
          </Typography.Text>
          <div>
            <Button type="danger" loading={pending && running === 'cancel'} disabled={disabled} onClick={cancel}>
              撤销未结账开台
            </Button>
          </div>
        </div>
      ) : null}

      {seatMove ? (
        <Typography.Text type="tertiary" size="small">
          {actions.end
            ? '扫码入座、预约到店开的按座计时没有陪客，也不能当误开撤销：用完点上面的「结束」。'
            : '扫码入座、预约到店开的按座计时没有陪客，也不能当误开撤销：顾客买的套餐请结账。'}
        </Typography.Text>
      ) : null}
    </div>
  )
}
