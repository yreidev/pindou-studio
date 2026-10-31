import { ApiError } from '../../api/client'
import type { ServiceTable } from '../../api/table-codes'
import { readableError } from '../operations/messages'
import { selectedTables, tableLabel } from './tables'

/** 印在每张桌码下面的店名。 */
export const brandLine = 'Example示例工坊·拼豆·手作研究室'

/** 一张桌的桌码在这次页面里的状态。只存在页面里：桌码是微信生成的图片，不是业务状态。 */
export type CodeState =
  { status: 'loading' } | { status: 'done'; dataUrl: string } | { status: 'failed'; message: string }

export function codeErrorMessage(error: unknown): string {
  // 后端对停用或不存在的桌回 404（只带英文代号）
  if (error instanceof ApiError && error.status === 404) return '这张桌已停用或不存在，不能出码'
  return readableError(error, '桌码生成失败，请稍后重试')
}

export interface BatchResult {
  done: number
  failed: number
  /** 中途被停下（点了停止或离开页面），剩下的没有请求。 */
  stopped: boolean
}

/**
 * 逐张生成：一张请求完再请求下一张（后端每张都要找微信，并发只会互相拖慢、撞微信的频率限制）。
 * 单张失败只记下来，接着生成其余的；shouldStop 返回 true 时不再发起新的请求。
 */
export async function generateInSequence(
  ids: readonly string[],
  generate: (id: string) => Promise<string>,
  report: {
    onStart?: (id: string) => void
    onDone: (id: string, dataUrl: string) => void
    onFail: (id: string, error: unknown) => void
  },
  shouldStop: () => boolean = () => false,
): Promise<BatchResult> {
  const result: BatchResult = { done: 0, failed: 0, stopped: false }
  for (const id of ids) {
    if (shouldStop()) {
      result.stopped = true
      break
    }
    report.onStart?.(id)
    try {
      const dataUrl = await generate(id)
      result.done++
      report.onDone(id, dataUrl)
    } catch (error) {
      result.failed++
      report.onFail(id, error)
    }
  }
  return result
}

export type PerPage = 1 | 4 | 6

export const printLayouts: { perPage: PerPage; label: string }[] = [
  { perPage: 1, label: '每页 1 张' },
  { perPage: 4, label: '每页 4 张' },
  { perPage: 6, label: '每页 6 张' },
]

export interface PrintItem {
  id: string
  label: string
  dataUrl: string
}

/**
 * 要打印的桌码：平时是所选桌里已经生成成功的；在预览里点「只打印这一张」时只有那一张
 * （不管它有没有被勾选）。停用的桌一律不打印。
 */
export function printItems(
  tables: readonly ServiceTable[],
  excluded: ReadonlySet<string>,
  codes: Readonly<Record<string, CodeState>>,
  only: string | null = null,
): PrintItem[] {
  const scope = only ? tables.filter((table) => table.id === only && table.enabled) : selectedTables(tables, excluded)
  return scope.flatMap((table) => {
    const code = codes[table.id]
    return code?.status === 'done' ? [{ id: table.id, label: tableLabel(table), dataUrl: code.dataUrl }] : []
  })
}

/** 按每页张数分页。 */
export function paginate<T>(items: readonly T[], perPage: number): T[][] {
  const pages: T[][] = []
  for (let start = 0; start < items.length; start += perPage) pages.push(items.slice(start, start + perPage))
  return pages
}

/** data URL → 文件内容（单张下载用）。不用 fetch(data:)，免得受页面 CSP 的 connect-src 限制。 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('桌码图片格式不对')
  const type = match[1] || 'application/octet-stream'
  if (!match[2]) return new Blob([decodeURIComponent(match[3])], { type })
  const binary = atob(match[3])
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type })
}

/** 下载的文件名：桌码-A1.png（微信可能回 JPEG；网页桌码是 SVG）。 */
export function codeFilename(label: string, dataUrl: string): string {
  const extension = dataUrl.startsWith('data:image/jpeg')
    ? 'jpg'
    : dataUrl.startsWith('data:image/svg+xml')
      ? 'svg'
      : 'png'
  return `桌码-${label}.${extension}`
}

/** 桌码的两种：网页桌码（普通二维码，微信扫了打开小程序）与微信小程序码（要小程序正式版）。 */
export type CodeKind = 'web' | 'mini'

export const codeKinds: { kind: CodeKind; label: string }[] = [
  { kind: 'web', label: '网页桌码' },
  { kind: 'mini', label: '小程序码' },
]
