/**
 * 标签页标题提醒：页面在后台（切到别的标签页、最小化）时来了新呼叫，标题改成「(2) 新呼叫 · 示例工坊后台」并闪烁，
 * 在浏览器的标签栏、任务栏上也看得到；切回这个页面就恢复原标题。
 *
 * 闪烁是在「(2) 新呼叫 · 原标题」和「(2) 原标题」之间来回换：数字一直在，「新呼叫」三个字一闪一闪。
 * 浏览器会放慢后台页面的定时器（Chrome 在后台久了可能一分钟才走一次），所以闪得慢也没关系，数字始终看得到。
 */
export function alertTitle(count: number, base: string, lit = true): string {
  return lit ? `(${count}) 新呼叫 · ${base}` : `(${count}) ${base}`
}

export class TitleAlert {
  /** 开始提醒前的原标题；null 表示现在没在提醒。 */
  private base: string | null = null
  private count = 0
  private lit = true
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly doc: Pick<Document, 'title'>
  private readonly intervalMs: number

  constructor(doc: Pick<Document, 'title'> = document, intervalMs = 1000) {
    this.doc = doc
    this.intervalMs = intervalMs
  }

  /** 显示 count 条新呼叫并闪烁；count 为 0 时恢复原标题。 */
  show(count: number): void {
    if (count <= 0) {
      this.clear()
      return
    }
    this.base ??= this.doc.title
    this.count = count
    this.lit = true
    this.doc.title = alertTitle(count, this.base)
    this.timer ??= setInterval(() => {
      if (this.base === null) return
      this.lit = !this.lit
      this.doc.title = alertTitle(this.count, this.base, this.lit)
    }, this.intervalMs)
  }

  /** 恢复原标题、停止闪烁。 */
  clear(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    if (this.base !== null) this.doc.title = this.base
    this.base = null
  }

  get active(): boolean {
    return this.base !== null
  }
}
