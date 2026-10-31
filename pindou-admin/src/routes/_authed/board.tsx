import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { boardQuery } from '../../api/board'
import { Page, QueryState } from '../../components/Page'
import { Board, BoardToolbar } from '../../features/board/Board'
import { refetchInterval } from '../../features/board/board'
import { useBoardFullscreen, useNow } from '../../features/board/hooks'
import { useRealtime } from '../../realtime/RealtimeProvider'

// 「现场」看板：柜台电脑或平板全屏常开（docs/plan-live-board.md 第 3、4 节）。
// 所有员工都能看；能做什么由后端按角色判断。
export const Route = createFileRoute('/_authed/board')({
  component: BoardPage,
})

function BoardPage() {
  const { status } = useRealtime()
  // 实时事件到达时随全部查询过期重读；另按连接状态定时重读（快到点、超时随时间变化，没有事件）
  const board = useQuery({ ...boardQuery(), refetchInterval: refetchInterval(status) })
  // 两次重读之间按 endsAt 每秒倒数
  const now = useNow(1000)
  const fullscreen = useBoardFullscreen()

  return (
    <div className="board">
      <Page
        title="现场"
        extra={
          <BoardToolbar
            status={status}
            updatedAt={board.dataUpdatedAt}
            refreshing={board.isFetching}
            onRefresh={() => void board.refetch()}
            fullscreen={fullscreen.active}
            onToggleFullscreen={fullscreen.toggle}
          />
        }
      >
        <QueryState query={board}>
          {(data) => <Board data={data} now={now} fetchedAt={board.dataUpdatedAt} />}
        </QueryState>
      </Page>
    </div>
  )
}
