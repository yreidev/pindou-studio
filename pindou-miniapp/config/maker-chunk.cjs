// 做图纸的代码只进 pages/maker 分包（docs/plan-bead-maker.md）。
// Taro 的 vite 编译器把被两个以上模块引用的源码一律放进主包的 common.js、node_modules 一律放进主包的 vendors.js
// （@tarojs/vite-runner dist/mini/config.js 的 getManualChunks），色卡数据、culori 和转图算法就跟着进了主包。
// 这里在它前面先认一遍：只有做图纸用到的模块放进 pages/maker/shared.js（分包里的页面可以引主包的，主包引不到分包的）。
// 页面目录里各页签的文件同理。底部「图纸」（主包）和「本次手作」也要用的 api、store、grid、boards、mine 不在这里，照旧进 common.js；
// 万一主包的代码引到了分包这一块，构建直接失败，免得上线后主包页面在分包没下载时白屏。
const chunk = 'pages/maker/shared'
const sharedWithMain = new Set(['api', 'store', 'grid', 'boards', 'mine'])

function makerOnly(id) {
  const file = id.split('?')[0].replace(/\\/g, '/')
  if (/\.(?:s?css|wxss)$/.test(file)) return false
  if (file.includes('/node_modules/culori/') || file.endsWith('/palettes/palettes.json')) return true
  // 页面目录里各页签的文件（pattern/edit-tab.tsx 等）被两个模块引用时也会被挪去 common.js；页面本身（index.tsx）留在各自页面里
  if (/\/src\/pages\/maker\/.+\.tsx?$/.test(file)) return !file.endsWith('/index.tsx')
  const m = file.match(/\/src\/(services|components)\/maker\/([^/.]+)\.[a-z]+$/)
  return !!m && !(m[1] === 'services' && sharedWithMain.has(m[2]))
}

module.exports = function makerChunk() {
  return {
    name: 'pindou-maker-chunk',
    enforce: 'post',
    // 这些模块只定义函数和常量、没有副作用。不告诉 rollup 的话，它为了保住副作用的执行顺序，
    // 会让每个页面和 app.js 都空引一次 shared.js（2026-10-21 实测），主包一启动就去读分包的文件
    transform(_code, id) {
      return makerOnly(id) ? { moduleSideEffects: false } : null
    },
    configResolved(config) {
      const output = config.build.rollupOptions.output
      for (const o of Array.isArray(output) ? output : [output]) {
        if (!o) continue
        const base = o.manualChunks
        o.manualChunks = (id, api) => (makerOnly(id) ? chunk : typeof base === 'function' ? base(id, api) : undefined)
      }
    },
    generateBundle(_options, bundle) {
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type !== 'chunk' || name.startsWith('pages/maker/')) continue
        if (file.imports.includes(`${chunk}.js`))
          this[process.env.MAKER_CHUNK_WARN ? 'warn' : 'error'](
            `${name} 引到了做图纸分包里的代码（${chunk}.js 的 ${(file.importedBindings[`${chunk}.js`] ?? []).join('、')}），主包和别的分包引不到它`,
          )
      }
    },
  }
}
