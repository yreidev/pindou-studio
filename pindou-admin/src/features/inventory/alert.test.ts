import { describe, expect, it } from 'vitest'
import { alertChangeLines, maxAlertAt, parseAlertAt } from './alert'

describe('预警线输入', () => {
  it('0 和正整数可以，和原来一样的不用提交', () => {
    expect(parseAlertAt('5', 0)).toEqual({ ok: true, value: 5 })
    expect(parseAlertAt(' 0 ', 3)).toEqual({ ok: true, value: 0 })
    expect(parseAlertAt(String(maxAlertAt), 0)).toEqual({ ok: true, value: maxAlertAt })
    expect(parseAlertAt('10', 10)).toEqual({ ok: false, message: '和原来的预警线一样，不用修改' })
  })

  it('空、负数、小数、超过上限都拦下', () => {
    expect(parseAlertAt('  ', 0)).toEqual({ ok: false, message: '请填写预警线' })
    for (const text of ['-1', '2.5', '1e3', '三', String(maxAlertAt + 1)])
      expect(parseAlertAt(text, 0)).toEqual({ ok: false, message: '预警线填 0 到 1000000 之间的整数' })
  })

  it('确认内容写清商品、原值和新值、当前库存', () => {
    expect(alertChangeLines({ name: '珠光豆 5mm', quantity: 30, from: 10, to: 35 })).toEqual([
      '商品：珠光豆 5mm',
      '预警线：10 件 → 35 件',
      '当前库存：30 件',
      '库存不高于预警线时，库存表显示「库存偏低」，「只看预警」也会列出它。',
    ])
  })
})
