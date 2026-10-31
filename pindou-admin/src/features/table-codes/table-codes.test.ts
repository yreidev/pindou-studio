import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import type { ServiceTable } from '../../api/table-codes'
import {
  codeErrorMessage,
  codeFilename,
  dataUrlToBlob,
  generateInSequence,
  paginate,
  printItems,
  type CodeState,
} from './codes'
import { groupTables, seatText, selectedTables, tableLabel } from './tables'

const table = (overrides: Partial<ServiceTable>): ServiceTable => ({
  id: 't',
  code: '',
  zone: '',
  floorAreaId: 'area-b',
  number: 1,
  seatCount: 1,
  wholeTable: false,
  enabled: true,
  occupancy: 'idle',
  seatBased: false,
  ...overrides,
})

describe('桌位分组', () => {
  const areas = [
    { id: 'area-b', name: 'B 区' },
    { id: 'area-a', name: 'A 区' },
  ]

  it('按区域名称排，区内按桌号排；对不上区域的放最后', () => {
    const groups = groupTables(
      [
        table({ id: 'b10', code: 'B10', number: 10 }),
        table({ id: 'b2', code: 'B2', number: 2 }),
        table({ id: 'a1', code: 'A1', number: 1, floorAreaId: 'area-a', seatCount: 2, wholeTable: true }),
        table({ id: 'x', number: 3, floorAreaId: 'gone' }),
      ],
      areas,
    )
    expect(groups.map((group) => group.title)).toEqual(['A 区', 'B 区', '未分区'])
    expect(groups[1].tables.map((item) => item.id)).toEqual(['b2', 'b10'])
  })

  it('桌名用布局编码，没有编码时用区域加桌号；座位写明整桌', () => {
    expect(tableLabel({ code: 'B3', number: 3 })).toBe('B3')
    // 老数据没有编码时后端给空串
    expect(tableLabel({ code: '', number: 3 }, 'B 区')).toBe('B 区 3 号桌')
    expect(tableLabel({ code: '', number: 3 })).toBe('3 号桌')
    expect(seatText({ seatCount: 2, wholeTable: true })).toBe('2 座 · 整桌')
    expect(seatText({ seatCount: 1, wholeTable: false })).toBe('1 座')
  })

  it('批量范围只含启用且没被取消勾选的桌', () => {
    const tables = [table({ id: 'on' }), table({ id: 'off', enabled: false }), table({ id: 'skip' })]
    expect(selectedTables(tables, new Set(['skip'])).map((item) => item.id)).toEqual(['on'])
    // 停用的桌即使没在排除名单里也不出码
    expect(selectedTables(tables, new Set()).map((item) => item.id)).toEqual(['on', 'skip'])
  })
})

describe('批量生成', () => {
  it('逐张请求：上一张完成才开始下一张；失败不影响其余', async () => {
    const log: string[] = []
    let inFlight = 0
    const generate = async (id: string) => {
      inFlight++
      log.push(`start ${id} (${inFlight})`)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      if (id === 'B3') throw new ApiError(503, 'wechat_unavailable', '微信返回 errcode 45009')
      return `data:image/png;base64,${id}`
    }
    const done: string[] = []
    const failed: string[] = []
    const result = await generateInSequence(['A1', 'B3', 'C1'], generate, {
      onDone: (id) => done.push(id),
      onFail: (id, error) => failed.push(`${id}: ${codeErrorMessage(error)}`),
    })
    expect(log).toEqual(['start A1 (1)', 'start B3 (1)', 'start C1 (1)'])
    expect(done).toEqual(['A1', 'C1'])
    expect(failed).toEqual(['B3: 微信返回 errcode 45009'])
    expect(result).toEqual({ done: 2, failed: 1, stopped: false })
  })

  it('停下后不再发起新的请求', async () => {
    const requested: string[] = []
    let stop = false
    const result = await generateInSequence(
      ['A1', 'A2', 'B1'],
      async (id) => {
        requested.push(id)
        stop = true
        return 'data:image/png;base64,x'
      },
      { onDone: () => {}, onFail: () => {} },
      () => stop,
    )
    expect(requested).toEqual(['A1'])
    expect(result).toEqual({ done: 1, failed: 0, stopped: true })
  })

  it('停用或不存在的桌（404）说清楚原因', () => {
    expect(codeErrorMessage(new ApiError(404, 'not_found', 'not_found'))).toBe('这张桌已停用或不存在，不能出码')
    expect(codeErrorMessage(new ApiError(503, 'wechat_unavailable', '尚未配置微信小程序码服务'))).toBe(
      '尚未配置微信小程序码服务',
    )
  })
})

describe('打印与下载', () => {
  it('打印所选里生成成功的；只打印一张时不管勾没勾选；停用的桌一律不打印', () => {
    const tables = [
      table({ id: 'a1', code: 'A1' }),
      table({ id: 'b1', code: 'B1' }),
      table({ id: 'b2', code: 'B2', enabled: false }),
      table({ id: 'b3', code: 'B3' }),
      table({ id: 'c1', code: 'C1' }),
    ]
    const done = (dataUrl: string): CodeState => ({ status: 'done', dataUrl })
    const codes: Record<string, CodeState> = {
      a1: done('data:a1'),
      b1: done('data:b1'),
      b2: done('data:b2'),
      b3: { status: 'failed', message: '失败' },
      c1: done('data:c1'),
    }
    const excluded = new Set(['c1'])
    expect(printItems(tables, excluded, codes)).toEqual([
      { id: 'a1', label: 'A1', dataUrl: 'data:a1' },
      { id: 'b1', label: 'B1', dataUrl: 'data:b1' },
    ])
    expect(printItems(tables, excluded, codes, 'c1')).toEqual([{ id: 'c1', label: 'C1', dataUrl: 'data:c1' }])
    expect(printItems(tables, excluded, codes, 'b2')).toEqual([])
    expect(printItems(tables, excluded, codes, 'b3')).toEqual([])
  })

  it('按每页张数分页', () => {
    expect(paginate([1, 2, 3, 4, 5], 4)).toEqual([[1, 2, 3, 4], [5]])
    expect(paginate([1, 2], 1)).toEqual([[1], [2]])
    expect(paginate([], 6)).toEqual([])
  })

  it('data URL 还原成图片文件', async () => {
    const blob = dataUrlToBlob('data:image/png;base64,iVBORw0KGgo=')
    expect(blob.type).toBe('image/png')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(() => dataUrlToBlob('not a data url')).toThrow()
    expect(codeFilename('A1', 'data:image/png;base64,x')).toBe('桌码-A1.png')
    expect(codeFilename('B3', 'data:image/jpeg;base64,x')).toBe('桌码-B3.jpg')
    expect(codeFilename('C2', 'data:image/svg+xml;charset=utf-8,%3Csvg')).toBe('桌码-C2.svg')
  })
})
