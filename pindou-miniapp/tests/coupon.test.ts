import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'

// 团购记录与套餐写法（2026-10-10 起钱在美团、大众点评收）。团购规则同后端 reservations/domain 的 NormalizeCoupon
// 和网页后台 lib/coupon.ts。

const coupon = await load('services/coupon.ts')
const packages = await load('services/packages.ts', {
  './format': { money: (cents: number) => (cents / 100).toFixed(2), storeOffsetMinutes: 8 * 60 },
})

test('团购：券码去掉空白再带，平台不选就不带；到店再买不带券码', () => {
  assert.equal(coupon.couponInput({ platform: '', code: '' }), undefined)
  assert.deepEqual(coupon.couponInput({ platform: 'meituan', code: ' 1234 5678\t9012 ' }), {
    platform: 'meituan',
    code: '123456789012',
  })
  assert.deepEqual(coupon.couponInput({ platform: 'dianping', code: '' }), { platform: 'dianping' })
  assert.deepEqual(coupon.couponInput({ platform: 'in_store', code: '' }), { platform: 'in_store' })
})

test('团购：和后端一样的拒绝条件', () => {
  assert.equal(coupon.couponProblem({ platform: '', code: '' }), '')
  assert.equal(coupon.couponProblem({ platform: '', code: '12' }), '填了券码要选是哪个平台的')
  assert.equal(coupon.couponProblem({ platform: 'in_store', code: '12' }), '到店再买不用填券码')
  assert.equal(coupon.couponProblem({ platform: 'meituan', code: '12-34' }), '券码只能是字母和数字')
  assert.equal(coupon.couponProblem({ platform: 'meituan', code: 'A'.repeat(32) }), '')
  assert.equal(
    coupon.couponProblem({ platform: 'meituan', code: `${'A'.repeat(16)} ${'B'.repeat(17)}` }),
    '券码最多 32 位',
  )
})

test('团购：四位一段给店员对着开店宝核；买了团购的提醒先验券', () => {
  assert.equal(coupon.couponText({ platform: 'meituan', code: '123456789012' }), '美团 · 券码 1234 5678 9012')
  assert.equal(coupon.couponText({ platform: 'dianping' }), '大众点评')
  assert.equal(coupon.couponText({ platform: 'in_store' }), '到店再买')
  assert.equal(coupon.couponText(null), '')
  assert.equal(coupon.couponReminder({ platform: 'dianping' }), '请先在美团开店宝验券')
  assert.equal(coupon.couponReminder({ platform: 'in_store' }), '')
  assert.ok(coupon.sameCoupon(undefined, { platform: '' }), '没填和空平台是同一个')
  assert.ok(!coupon.sameCoupon({ platform: 'meituan', code: '1' }, { platform: 'meituan', code: '2' }))
  assert.deepEqual(coupon.couponDraftOf(undefined), { platform: '', code: '' })
})

test('套餐：到打烊的写「到打烊」，按门店时间算到打烊；收费关着不写价格', () => {
  const close = { name: '全天', durationMinutes: 0, amountCents: 0, untilClose: true }
  const timed = { name: '两小时', durationMinutes: 120, amountCents: 5900 }
  assert.equal(packages.packageDuration(close), '到打烊')
  assert.equal(packages.packageLine(timed, true), '两小时 · 120 分钟 · ¥59.00')
  assert.equal(packages.packageLine(timed, false), '两小时 · 120 分钟')
  assert.equal(packages.slotMinutesOf(close), 1, '到打烊的只要在打烊前开始就能约')
  assert.equal(packages.slotMinutesOf(timed), 120)
  // 门店 22:00 打烊；UTC 08:30 是门店 16:30
  const start = new Date('2026-10-10T08:30:00Z')
  assert.equal(packages.storeMinute(start), 16 * 60 + 30)
  assert.equal(packages.bookingMinutes(close, start, 22 * 60), 330)
  assert.equal(packages.bookingMinutes(timed, start, 22 * 60), 120)
  assert.equal(packages.bookingMinutes(close, new Date('2026-10-10T14:30:00Z'), 22 * 60), 0, '过了打烊为 0')
})
