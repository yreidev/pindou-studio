import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 顶层的 vite 是 Taro 构建用的 4.x（Vitest 自带的另一份不在这里），测的就是真实构建链
import { build } from 'vite'
import { onTestFinished, test } from 'vitest'
import modernSass from '../config/modern-sass.cjs'

async function fixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pindou-sass-'))
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fs.writeFile(path.join(root, name), content)
  }
  return root
}

test('modern Sass preserves @use, PostCSS processing and relative image assets in Vite builds', async () => {
  const root = await fixture({
    'entry.js': "import './styles/main.scss'; import './styles/extra.sass';",
    'styles/_tokens.scss': '$accent: #123456;',
    'styles/main.scss': '@use "tokens"; .sample { color: tokens.$accent; width: 44px; background: url(./dot.svg); }',
    'styles/extra.sass': '.indented\n  height: 12px\n',
    'styles/dot.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  })
  const messages: string[] = []
  const result = await build({
    root,
    configFile: false,
    plugins: [modernSass()],
    customLogger: {
      info() {},
      warn(message: string) {
        messages.push(message)
      },
      warnOnce(message: string) {
        messages.push(message)
      },
      error(message: string) {
        messages.push(message)
      },
      clearScreen() {},
      hasErrorLogged() {
        return false
      },
      hasWarned: false,
    },
    css: {
      postcss: {
        plugins: [
          {
            postcssPlugin: 'test-unit-transform',
            Declaration(declaration: any) {
              if (declaration.value === '44px') declaration.value = '44rpx'
            },
          },
        ],
      },
    },
    build: { write: false, assetsInlineLimit: 0, rollupOptions: { input: path.join(root, 'entry.js') } },
  })
  const output = (result as any).output as any[]
  const css = output
    .filter((item) => item.fileName.endsWith('.css'))
    .map((item) => item.source)
    .join('\n')
  assert.match(css, /color:#123456/)
  assert.match(css, /width:44rpx/)
  assert.match(css, /height:12px/)
  const asset = output.find((item) => item.fileName.endsWith('.svg'))
  assert.ok(asset, 'relative image should be emitted')
  assert.ok(css.includes(`/${asset.fileName}`), 'CSS should reference the bundled image')
  assert.deepEqual(messages, [])
})

test('Sass partial changes recompile their consumers and preserve source maps', async () => {
  const root = await fixture({
    '_tokens.scss': '$size: 20px;',
    'main.scss': '@use "tokens"; .sample { width: tokens.$size; }',
  })
  const plugin = modernSass()
  const file = path.join(root, 'main.scss')
  const partial = path.join(root, '_tokens.scss')
  const watched = new Set<string>()
  const context = {
    async resolve(source: string) {
      return { id: source }
    },
    addWatchFile(dependency: string) {
      watched.add(dependency)
    },
  }
  const id = await plugin.resolveId.call(context, file)
  const initial = await plugin.load.call(context, id)
  assert.match(initial.code, /width: 20px/)
  assert.deepEqual(watched, new Set([file, partial]))
  assert.ok(initial.map.sources.map(fileURLToPath).includes(file))
  assert.ok(initial.map.sourcesContent.some((content) => content.includes('@use "tokens"')))

  // A second JS consumer resolves the same stylesheet without losing watches.
  assert.equal(await plugin.resolveId.call(context, file), id)
  const consumer = { id }
  const unrelated = { id: 'unrelated.js' }
  const update = {
    file: partial,
    modules: [unrelated],
    server: { moduleGraph: { getModuleById: (candidate: string) => (candidate === id ? consumer : undefined) } },
  }
  assert.deepEqual(plugin.handleHotUpdate(update), [unrelated, consumer])
  await fs.writeFile(partial, '$size: 32px;')
  const updated = await plugin.load.call(context, id)
  assert.match(updated.code, /width: 32px/)
  assert.doesNotMatch(updated.code, /width: 20px/)
  assert.deepEqual(plugin.handleHotUpdate({ ...update, file: path.join(root, 'other.scss') }), [unrelated])
})

test('Sass syntax and missing-import failures still fail the build', async () => {
  const root = await fixture({
    'invalid.scss': '.broken { color: $unknown; }',
    'missing.scss': '@use "does-not-exist";',
  })
  for (const name of ['invalid.scss', 'missing.scss']) {
    const plugin = modernSass()
    const context = {
      async resolve(source: string) {
        return { id: source }
      },
      addWatchFile() {},
    }
    const id = await plugin.resolveId.call(context, path.join(root, name))
    await assert.rejects(plugin.load.call(context, id), /Undefined variable|Can't find stylesheet/)
  }
})
