import { dateTime } from '../../lib/format'

/** 示例工坊-数据-2026-10-05_10-30.json：下载时间按门店时区。 */
export function dataExportFilename(at: Date): string {
  return `示例工坊-数据-${dateTime(at.toISOString()).replace(' ', '_').replace(':', '-')}.json`
}
