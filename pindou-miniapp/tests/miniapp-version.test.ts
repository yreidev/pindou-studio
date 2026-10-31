import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'

test('上报微信实际给出的正式版版本，不拿构建版本替代；体验版和开发版不上报', async () => {
  const writes: unknown[][] = []
  const miniProgram = { envVersion: 'release', version: '0.0.38' }
  const { reportMiniappVersion } = await load<typeof import('../src/services/miniapp-version')>(
    'services/miniapp-version.ts',
    {
      '@tarojs/taro': { getAccountInfoSync: () => ({ miniProgram }) },
      './staff': {
        request: async (...args: unknown[]) => {
          writes.push(args)
        },
      },
    },
  )
  await reportMiniappVersion()
  assert.deepEqual(writes, [['/system/miniapp-version', 'POST', { envVersion: 'release', version: '0.0.38' }]])
  for (const env of ['trial', 'develop']) {
    miniProgram.envVersion = env
    miniProgram.version = '0.0.99'
    await reportMiniappVersion()
  }
  assert.equal(writes.length, 1)
  miniProgram.envVersion = 'release'
  miniProgram.version = ''
  await assert.rejects(reportMiniappVersion(), /正式版未提供运行版本号/)
  assert.equal(writes.length, 1)
})

test('上报失败保留错误，交给应用记录操作名，不伪造成功', async () => {
  const failure = new Error('网络连接失败')
  const { reportMiniappVersion } = await load<typeof import('../src/services/miniapp-version')>(
    'services/miniapp-version.ts',
    {
      '@tarojs/taro': { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '0.0.39' } }) },
      './staff': {
        request: async () => {
          throw failure
        },
      },
    },
  )
  await assert.rejects(reportMiniappVersion(), (error) => error === failure)
})
