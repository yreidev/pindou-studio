import { queryOptions } from '@tanstack/react-query'
import { client, read, type Schemas } from './client'

// 呼叫店员（service-calls 资源）：顾客在小程序「本次手作」页呼叫，店员看还没处理的，可以先点「我去处理」认领
// （别的员工那里显示谁在处理、不再响铃），去了之后点「已处理」。

/**
 * 一次呼叫。tableCode、seatNumber 是会话现在的位置（顾客换了座也不会找错）；displayStatus 是此刻的状态
 * （没人处理的 30 分钟后显示为 expired，由后端按时间算）；claimStatus 是此刻的认领状态（认领满 10 分钟没处理变回
 * lapsed，也由后端按时间算）；customer、handledBy、claimedBy 是员工视图才带的称呼。
 */
export type ServiceCall = Schemas['ServiceCall']

export const serviceCallsApi = {
  /** 还没处理的呼叫：没处理、没过期、顾客的计时还在，先叫的在前；有人认领的照样列出。 */
  open: (signal?: AbortSignal) => read(client.GET('/service-calls', { params: { query: { scope: 'open' } }, signal })),
  /** 标记已处理。已经被别人处理过的原样返回（处理人不变），所以不用幂等键：重复点无害。 */
  handle: (id: string) =>
    read(client.POST('/service-calls/{serviceCallId}/handle', { params: { path: { serviceCallId: id } } })),
  /**
   * 「我去处理」。谁先认领算谁：别人认领着时 409 service_call_claimed（说明是「XX 已在处理」）；
   * 自己再点原样返回，所以不用幂等键。已处理、过期、顾客走了的 409 service_call_closed。
   */
  claim: (id: string) =>
    read(client.POST('/service-calls/{serviceCallId}/claim', { params: { path: { serviceCallId: id } } })),
}

/**
 * 还没处理的呼叫。全站的呼叫提醒一直订着它，所以标签页在后台时也随呼叫事件立刻重读
 * （realtimeInBackground，见 realtime/refresh.ts），别的查询在后台只标过期。
 */
export const openServiceCallsQuery = () =>
  queryOptions({
    queryKey: ['service-calls', 'open'],
    queryFn: ({ signal }) => serviceCallsApi.open(signal),
    meta: { realtimeInBackground: true },
  })
