import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'
import { settle } from './helpers/tree'

test('会员码打开读原亮度并调亮，关闭恢复原值且重复关闭不重复写入', async () => {
  const values: number[] = []
  const { brightenScreen } = await load('services/screen-brightness.ts', {
    '@tarojs/taro': {
      default: {
        getScreenBrightness: async () => ({ value: 0.4 }),
        setScreenBrightness: async ({ value }) => {
          values.push(value)
        },
      },
    },
  })
  const close = brightenScreen()
  await settle()
  assert.deepEqual(values, [1])
  close()
  close()
  await settle()
  assert.deepEqual(values, [1, 0.4])
})

test('读取未完成就关闭不会调亮；调亮未完成就关闭会在完成后恢复', async () => {
  let finishRead!: (result: { value: number }) => void
  let finishRaise!: () => void
  const values: number[] = []
  const { brightenScreen } = await load('services/screen-brightness.ts', {
    '@tarojs/taro': {
      default: {
        getScreenBrightness: () =>
          new Promise((resolve) => {
            finishRead = resolve
          }),
        setScreenBrightness: ({ value }) => {
          values.push(value)
          return value === 1
            ? new Promise<void>((resolve) => {
                finishRaise = resolve
              })
            : Promise.resolve()
        },
      },
    },
  })
  const early = brightenScreen()
  early()
  finishRead({ value: 0.2 })
  await settle()
  assert.deepEqual(values, [])
  const close = brightenScreen()
  finishRead({ value: 0.3 })
  await settle()
  assert.deepEqual(values, [1])
  close()
  await settle()
  assert.deepEqual(values, [1])
  finishRaise()
  await settle()
  assert.deepEqual(values, [1, 0.3])
})

test('微信拒绝亮度接口时不影响关闭；红点用 Taro 接口且兼容失败', async () => {
  const calls: unknown[] = []
  const taro = {
    getScreenBrightness: async () => {
      calls.push('brightness')
      throw new Error('不支持')
    },
    showTabBarRedDot: async (opts) => {
      calls.push(['show', opts])
      throw new Error('还没挂载')
    },
    hideTabBarRedDot: async (opts) => {
      calls.push(['hide', opts])
    },
  }
  const { brightenScreen } = await load('services/screen-brightness.ts', { '@tarojs/taro': { default: taro } })
  brightenScreen()()
  await settle()
  assert.deepEqual(calls, ['brightness'])
  const { messageRedDot } = await load('services/message-indicator.ts', { '@tarojs/taro': { default: taro } })
  await messageRedDot(true)
  await messageRedDot(false)
  assert.deepEqual(calls.slice(1), [
    ['show', { index: 3 }],
    ['hide', { index: 3 }],
  ])
})
