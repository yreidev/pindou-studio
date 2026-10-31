import assert from 'node:assert/strict'
import { test } from 'vitest'
import { approach, glideStep, resist, rubberBand, shouldDismiss, velocityTracker } from '../src/services/gesture'

test('测速只看松手前约 100 毫秒：相邻两次挨得很近不会测出乱跳的速度，慢拖后一甩也测得出来', () => {
  const v = velocityTracker()
  // 慢慢拖了 2 秒（每 16 毫秒 1 像素），最后 100 毫秒一甩走了 100 像素
  let y = 0
  for (let t = 0; t <= 2000; t += 16) v.push(t, 0, (y = t / 16))
  for (let t = 2016; t <= 2112; t += 16) v.push(t, 0, (y += 100 / 7))
  assert.ok(v.get()[1] > 0.8, `一甩的速度 ${v.get()[1]}`)

  // 两个触点只隔 0.5 毫秒：不能算成 12 像素/毫秒
  v.reset()
  v.push(0, 0, 0)
  v.push(50, 0, 34)
  v.push(100, 0, 40)
  v.push(100.5, 0, 46)
  assert.ok(v.get()[1] < 0.6, `窗口速度 ${v.get()[1]}`)

  v.reset()
  v.push(0, 3, 4)
  assert.deepEqual(v.get(), [0, 0])
})

test('弹层松手：拖过三分之一或往下甩够快就关，轻轻拖一点慢慢松手弹回，拖远了又往上甩回去不关', () => {
  assert.equal(shouldDismiss(150, 400, 0), true)
  assert.equal(shouldDismiss(20, 400, 0.8), true)
  assert.equal(shouldDismiss(60, 400, 0.1), false)
  assert.equal(shouldDismiss(200, 400, -0.8), false)
})

test('往上拖只走三成；拖出边界越拖越难，永远拖不到上限', () => {
  assert.equal(resist(100), 30)
  assert.ok(rubberBand(90, 120) > 40 && rubberBand(90, 120) < 90)
  assert.ok(rubberBand(1000, 120) < 120)
  assert.ok(rubberBand(-90, 120) < 0)
  assert.equal(rubberBand(50, 0), 0)
})

test('滑行一帧：走的距离按速度算，速度按每 16 毫秒乘一次摩擦减下来', () => {
  const a = glideStep(1, 16)
  assert.equal(a.distance, 16)
  assert.ok(Math.abs(a.velocity - 0.92) < 1e-9)
  const b = glideStep(1, 32)
  assert.ok(Math.abs(b.velocity - 0.92 * 0.92) < 1e-9)
})

test('弹回一帧：每 16 毫秒剩七成，差不到 epsilon 就落到目标上（不会一直差一点点地画下去）', () => {
  assert.ok(Math.abs(approach(100, 0, 16) - 70) < 1e-9)
  assert.equal(approach(0.6, 0, 16), 0)
  let x = 300
  let n = 0
  while (x !== 0 && n < 200) {
    x = approach(x, 0, 16)
    n++
  }
  assert.equal(x, 0)
  assert.ok(n < 30, `${n} 帧`)
})
