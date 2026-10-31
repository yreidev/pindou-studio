import { useEffect, useRef, useState } from 'react'
import { keepPreviousData, useStaffQuery } from './query'
import { isRestricted } from '../services/query'
import { staffMessage, type Page } from '../services/staff'

/** 输入停顿多久才去查：边打字边查会把每个字都发一次请求。 */
export const searchDelay = 300

export type SearchState<T> = {
  items: T[]
  total: number
  /** 服务端实际返回的页码，从 1 起（超出时服务端落到最后一页）。 */
  page: number
  /** 关键字或页码变了、新结果还没回来。实时刷新、定时刷新是静默的，不置这个。 */
  loading: boolean
  error: string
  /** 至少成功读到过一次。 */
  ready: boolean
}

/**
 * 关键字停顿 300ms 才交出去；页码变了立即交出（翻页不等）。还在打字时交出的是上一次的关键字和页码。
 */
function useTypingPause(keyword: string, page: number) {
  const [settled, setSettled] = useState({ keyword, page })
  useEffect(() => {
    if (keyword === settled.keyword) return
    const timer = setTimeout(() => setSettled({ keyword, page }), searchDelay)
    return () => clearTimeout(timer)
  }, [keyword, page, settled.keyword])
  return keyword === settled.keyword ? { keyword, page } : settled
}

/**
 * 员工找人（顾客、会员）：把关键字交给服务端筛选分页，只取这一页。
 *
 * ★ 以前是把全店账户整表拉下来在手机上筛 —— 账户越多越慢，每来一条实时事件还要重拉全部。
 *   现在关键字变了等输入停顿 300ms 再查；翻页、重试立即查；实时事件与页面的定时刷新（refetchInterval）
 *   静默重查，不清空当前结果。关键字和页码都在查询键里，迟到的旧响应只会落到旧键上，不会盖掉新的。
 */
export function useServerSearch<T>(
  resource: readonly unknown[],
  load: (keyword: string, page: number) => Promise<Page<T>>,
  keyword: string,
  {
    page = 1,
    refetchInterval,
    enabled = true,
  }: { page?: number; refetchInterval?: number | false; enabled?: boolean } = {},
) {
  const trimmed = keyword.trim()
  const settled = useTypingPause(trimmed, page)
  const query = useStaffQuery([...resource, settled.keyword, settled.page], () => load(settled.keyword, settled.page), {
    placeholderData: keepPreviousData,
    refetchInterval,
    // 关着时（比如开台弹层里还没输入关键字）不去查
    enabled,
  })
  // 换了关键字之后那次失败了：仍显示上一次成功的结果（并提示），不闪空；无权时不留
  const lastGood = useRef<Page<T> | null>(null)
  useEffect(() => {
    if (query.data && !query.placeholder) lastGood.current = query.data
  }, [query.data, query.placeholder])
  const shown = query.data ?? (isRestricted(query.error) ? null : lastGood.current)
  const state: SearchState<T> = {
    items: shown?.items || [],
    total: shown?.total || 0,
    page: shown?.page || 1,
    loading: trimmed !== settled.keyword || query.placeholder || query.loading,
    error: query.error ? staffMessage(query.error) : '',
    ready: !!lastGood.current || (!!query.data && !query.placeholder),
  }
  return { ...state, retry: query.refresh }
}
