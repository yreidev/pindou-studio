import '@douyinfe/semi-ui/react19-adapter'
import { Modal } from '@douyinfe/semi-ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardData, VenueSession } from '../../api/board'
import { saveSession } from '../../session'
import { sessionActions, type BoardSeat } from './board'
import { SessionMore } from './SessionMore'
import { useBoardAction } from './useBoardAction'

// 会话详情里的「标记陪客」：陪客标了就改不回（不能再暂停、继续），标错只能撤销开台后重开，
// 所以先弹确认、写清后果；取消什么也不发，确认了才发 PATCH status=companion。

const now = Date.parse('2026-10-05T06:00:00Z')
const session: VenueSession = {
  id: '00000000-0000-4000-8000-0000000000b5',
  serviceTableId: '00000000-0000-4000-8000-0000000000a5',
  startedAt: new Date(now - 30 * 60_000).toISOString(),
  timingMode: 'timed',
  durationMinutes: 120,
  status: 'active',
}
const data: BoardData = {
  tables: [],
  sessions: [session],
  admissions: [],
  reservations: [],
  packages: [],
  closeMinute: 22 * 60,
  shiftTables: [],
}

/** 模拟后端：记下发来的写请求，PATCH 回改好的会话。 */
function backend() {
  const writes: { method: string; path: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname
      const body = request.method === 'GET' ? null : await request.json()
      writes.push({ method: request.method, path, body })
      return new Response(JSON.stringify({ session: { ...session, status: 'companion' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
  return writes
}

function Harness({ seat }: { seat: BoardSeat }) {
  const task = useBoardAction()
  const actions = sessionActions(seat, true)
  if (!actions) return null
  return (
    <SessionMore
      seat={seat}
      session={session}
      actions={actions}
      data={data}
      version=""
      now={now}
      busy={false}
      task={task}
      error={null}
      onClose={() => {}}
    />
  )
}

function mount() {
  saveSession({
    accessToken: 'web-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: 'u-clerk', nickname: '小店员', roles: ['clerk'] },
  })
  const seat = { code: 'B5', session } as unknown as BoardSeat
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Harness seat={seat} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  Modal.destroyAll()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('标记陪客', () => {
  it('先确认并写清后果；取消什么也不发', async () => {
    const writes = backend()
    mount()
    await userEvent.click(screen.getByRole('button', { name: '标记陪客' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('B5 标记为陪客后')
    expect(dialog.textContent).toContain('不计时，不收计时费')
    expect(dialog.textContent).toContain('不能再暂停或继续')
    expect(dialog.textContent).toContain('改不回普通计时。标错了只能撤销开台后重开')
    // 确认按钮写具体动作（不写「确定」），危险样式；读屏名就是按钮上的字
    const ok = screen.getByRole('button', { name: '标记为陪客' })
    expect(ok.className).toContain('semi-button-danger')
    expect(screen.queryByRole('button', { name: '确定' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    // 按钮回到能点的样子（没有请求在跑），也没发任何请求
    await waitFor(() => expect(screen.getByRole('button', { name: '标记陪客' }).hasAttribute('disabled')).toBe(false))
    expect(writes).toEqual([])
  })

  it('确认后才发 PATCH status=companion', async () => {
    const writes = backend()
    mount()
    await userEvent.click(screen.getByRole('button', { name: '标记陪客' }))
    await userEvent.click(await screen.findByRole('button', { name: '标记为陪客' }))
    await waitFor(() =>
      expect(writes).toEqual([
        { method: 'PATCH', path: `/api/v2/venue-sessions/${session.id}`, body: { status: 'companion' } },
      ]),
    )
  })
})
