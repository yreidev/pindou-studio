const { compileAsync } = require('sass')
const { fileURLToPath } = require('node:url')

// Taro 4's Vite 4 peer still invokes sass.render. Compile Sass through the
// modern API and hand CSS to Vite, which retains its PostCSS/asset pipeline.
module.exports = function modernSass() {
  const styles = new Map()
  return {
    name: 'pindou-modern-sass',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!/\.s[ac]ss$/.test(source)) return null
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      if (!resolved || resolved.external) return null
      const id = `${resolved.id}.css`
      if (!styles.has(id)) styles.set(id, { file: resolved.id, dependencies: new Set() })
      return id
    },
    async load(id) {
      const style = styles.get(id)
      if (!style) return null
      const result = await compileAsync(style.file, {
        sourceMap: true,
        sourceMapIncludeSources: true,
        fatalDeprecations: ['legacy-js-api'],
      })
      style.dependencies = new Set(result.loadedUrls.filter((url) => url.protocol === 'file:').map(fileURLToPath))
      for (const file of style.dependencies) this.addWatchFile(file)
      return { code: result.css, map: result.sourceMap }
    },
    handleHotUpdate(context) {
      const affected = new Set(context.modules)
      for (const [id, style] of styles) {
        if (!style.dependencies.has(context.file)) continue
        const module = context.server.moduleGraph.getModuleById(id)
        if (module) affected.add(module)
      }
      return [...affected]
    },
  }
}
