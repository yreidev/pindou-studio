import type { ReactNode } from 'react'

/** 表格里不该折行的短内容（时间、金额、表头）：列宽不够时让名称、原因这类长文字列去折行。 */
export function Nowrap({ children }: { children: ReactNode }) {
  return <span style={{ whiteSpace: 'nowrap' }}>{children}</span>
}
