import type { ExportKind } from '../../api/operations'

// 报表导出：日期是门店日期（中国标准时间，含当天），由后端按门店时区筛选；这里只管校验和文件名。

export interface ExportOption {
  kind: ExportKind
  label: string
  /** 按什么日期筛选；库存是当前数量，不按日期筛选。 */
  hint: string
  usesDates: boolean
}

export const exportOptions: ExportOption[] = [
  { kind: 'orders', label: '订单', hint: '按下单日期筛选', usesDates: true },
  { kind: 'refunds', label: '退款', hint: '按退款日期筛选', usesDates: true },
  { kind: 'purchases', label: '采购记录', hint: '按入库日期筛选', usesDates: true },
  {
    kind: 'movements',
    label: '库存流水',
    hint: '按发生日期筛选：采购入库、盘点、销售出库、退款回补、会员出入库逐笔列出',
    usesDates: true,
  },
  { kind: 'inventory', label: '库存', hint: '导出时的库存数量，不受日期限制', usesDates: false },
]

const datePattern = /^\d{4}-\d{2}-\d{2}$/

/** 开始、结束日期的问题；没问题返回 null。都可以不填（不限）。 */
export function exportRangeError(from: string, to: string): string | null {
  if ((from && !datePattern.test(from)) || (to && !datePattern.test(to))) return '日期格式应为 年-月-日'
  // 同为 YYYY-MM-DD，按字符串比较就是按日期比较
  if (from && to && from > to) return '开始日期不能晚于结束日期'
  return null
}

/**
 * 下载的文件名带种类和日期范围，存在一个文件夹里也分得清：
 * 示例工坊-订单-2026-10-01至2026-10-04.xlsx、示例工坊-订单-2026-10-01起.xlsx、示例工坊-订单-截至2026-10-04.xlsx；
 * 不限日期时写到哪天为止（today 为门店今天）。库存是当时的数量，只写导出日期。
 */
export function exportFilename(
  option: Pick<ExportOption, 'label' | 'usesDates'>,
  from: string,
  to: string,
  today: string,
) {
  const range = !option.usesDates
    ? today
    : from && to
      ? from === to
        ? from
        : `${from}至${to}`
      : from
        ? `${from}起`
        : to
          ? `截至${to}`
          : `全部-截至${today}`
  return `示例工坊-${option.label}-${range}.xlsx`
}

const pad = (value: number) => String(value).padStart(2, '0')

/** 常用日期范围（今天、本月、上月），以门店今天（YYYY-MM-DD）为准，不经过电脑时区。 */
export function quickRanges(today: string): { label: string; from: string; to: string }[] {
  const [year, month] = today.split('-').map(Number)
  const lastYear = month === 1 ? year - 1 : year
  const lastMonth = month === 1 ? 12 : month - 1
  // Date.UTC 的第 0 天就是上个月最后一天，只取日期数字，与时区无关
  const lastDay = new Date(Date.UTC(lastYear, lastMonth, 0)).getUTCDate()
  return [
    { label: '今天', from: today, to: today },
    { label: '本月', from: `${year}-${pad(month)}-01`, to: today },
    {
      label: '上月',
      from: `${lastYear}-${pad(lastMonth)}-01`,
      to: `${lastYear}-${pad(lastMonth)}-${pad(lastDay)}`,
    },
  ]
}
