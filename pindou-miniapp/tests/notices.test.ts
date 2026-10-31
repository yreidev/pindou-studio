import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'

// 顾客预约的微信订阅消息（services/notices.ts）：缺哪几种、订阅框怎么弹、允许了的怎么告诉后端。

const templates = [
  { kind: 'confirmed', templateId: 't-ok' },
  { kind: 'reminder', templateId: 't-soon' },
  { kind: 'cancelled', templateId: 't-off' },
]
const entry = (displayStatus: string, notices?: string[]) => ({ displayStatus, ...(notices ? { notices } : {}) }) as any

async function notices(taro: Record<string, unknown> = {}, request = async (..._args: unknown[]) => ({})) {
  return load('services/notices.ts', { '@tarojs/taro': { default: taro }, './staff': { request } })
}

test('缺哪几种：待确认要三种，已确认只要提醒和取消，结束了的不再开；只算门店开了的种类', async () => {
  const { missingNotices } = await notices()
  assert.deepEqual(missingNotices(entry('pending'), templates), ['confirmed', 'reminder', 'cancelled'])
  assert.deepEqual(missingNotices(entry('pending', ['reminder']), templates), ['confirmed', 'cancelled'])
  assert.deepEqual(missingNotices(entry('confirmed', ['cancelled']), templates), ['reminder'])
  assert.deepEqual(missingNotices(entry('confirmed', ['reminder', 'cancelled']), templates), [])
  for (const status of ['expired', 'seated', 'cancelled', 'no_show'])
    assert.deepEqual(missingNotices(entry(status), templates), [], status)
  assert.deepEqual(missingNotices(entry('pending'), []), [], '门店没开就什么都不缺')
  assert.deepEqual(missingNotices(entry('pending'), templates.slice(1)), ['reminder', 'cancelled'])
})

test('订阅框：只弹要的那几种，按模板顺序返回点了允许的；拒绝、被封、弹框出错都不算', async () => {
  const asked: unknown[] = []
  const { askNotices } = await notices({
    requestSubscribeMessage: async (option) => {
      asked.push(option)
      return { errMsg: 'requestSubscribeMessage:ok', 't-ok': 'accept', 't-soon': 'reject', 't-off': 'accept' }
    },
  })
  assert.deepEqual(await askNotices(templates, ['cancelled', 'confirmed', 'reminder']), ['confirmed', 'cancelled'])
  assert.deepEqual(asked, [{ tmplIds: ['t-ok', 't-soon', 't-off'] }])
  assert.deepEqual(await askNotices(templates, ['reminder']), [])
  assert.deepEqual(asked.at(-1), { tmplIds: ['t-soon'] })
  // 没有要弹的就不弹
  assert.deepEqual(await askNotices([], ['confirmed']), [])
  assert.equal(asked.length, 2)

  const banned = await notices({ requestSubscribeMessage: async () => ({ errMsg: 'ok', 't-ok': 'ban' }) })
  assert.deepEqual(await banned.askNotices(templates, ['confirmed']), [])
  const failing = await notices({
    requestSubscribeMessage: async () => {
      throw Object.assign(new Error('requestSubscribeMessage:fail'), { errCode: 20004 })
    },
  })
  assert.deepEqual(await failing.askNotices(templates, ['confirmed']), [], '顾客关了总开关：不打扰')
})

test('允许了的种类带一个新的登录码记到这条预约上', async () => {
  const sent: unknown[][] = []
  const { saveNotices } = await notices({ login: async () => ({ code: 'code-1' }) }, async (...args) => {
    sent.push(args)
    return { reservations: [] }
  })
  assert.deepEqual(await saveNotices('r/1', ['reminder', 'cancelled']), { reservations: [] })
  assert.deepEqual(sent, [
    ['/reservations/r%2F1/notices', 'POST', { wechatLoginCode: 'code-1', kinds: ['reminder', 'cancelled'] }],
  ])
})
