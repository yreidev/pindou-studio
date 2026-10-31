import type { QueryClient } from '@tanstack/react-query'

/**
 * 实时事件到达（或连上、切回标签页）后怎么刷新查询。
 *
 * - 全部查询过期（meta.realtime 为 false 的只算不写的计算示例除外）。页面在前台时正在用的立刻重读；
 *   在后台时只标记过期，切回来再读——后台没人看，不必每来一条事件就把整页数据重拉一遍。
 * - 例外：meta.realtimeInBackground 为 true 的查询（呼叫店员的未处理列表：人不在跟前也要提醒）在后台也立刻重读，
 *   只在事件里有它的资源名（queryKey 第一段）时读；resources 为 null 表示连上或切回，可能漏过事件，也读。
 */
export function refreshAfterRealtime(
  queryClient: QueryClient,
  { resources, visible }: { resources: readonly string[] | null; visible: boolean },
): void {
  void queryClient.invalidateQueries({
    predicate: (query) => query.meta?.realtime !== false,
    refetchType: visible ? 'active' : 'none',
  })
  if (visible) return
  void queryClient.refetchQueries({
    type: 'active',
    predicate: (query) =>
      query.meta?.realtimeInBackground === true &&
      (resources === null || resources.includes(String(query.queryKey[0]))),
  })
}
