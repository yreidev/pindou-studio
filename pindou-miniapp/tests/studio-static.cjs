const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const postcss = require('postcss')
const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const app = JSON.parse(fs.readFileSync(path.join(dist, 'app.json'), 'utf8'))
assert.equal(app.pages.length, 20)
assert.ok(!app.pages.some((page) => page.includes('qr-approve')))
assert.ok(!fs.existsSync(path.join(dist, 'pages/staff/qr-approve')))
assert.equal(app.window.backgroundColor, '#f7f5f0')
assert.equal(app.resizable, true)
assert.equal(app.window.pageOrientation, 'auto')
for (const page of app.pages) {
  assert.ok(fs.existsSync(path.join(root, 'src', page + '.tsx')), page)
  assert.ok(fs.existsSync(path.join(dist, page + '.js')), page)
}
for (const tab of app.tabBar.list)
  for (const key of ['iconPath', 'selectedIconPath']) {
    const image = fs.readFileSync(path.join(dist, tab[key]))
    assert.equal(image.readUInt32BE(16), 72)
    assert.equal(image.readUInt32BE(20), 72)
    assert.equal(image[25], 6, 'navigation image must retain RGBA')
  }
const jpgs = fs.readdirSync(path.join(root, 'src/assets/gallery')).filter((file) => file.endsWith('.jpg'))
assert.equal(jpgs.length, 12)
for (const file of jpgs)
  for (const output of ['dist'])
    assert.deepEqual(
      fs.readFileSync(path.join(root, 'src/assets/gallery', file)),
      fs.readFileSync(path.join(root, output, 'assets/gallery', file)),
    )
const sources = fs.readdirSync(path.join(root, 'src'), { recursive: true }).filter((file) => file.endsWith('.tsx'))
for (const file of sources)
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, 'src', file), 'utf8'),
    /assets\/customer(?:-home)?\//,
    `legacy visual import in ${file}`,
  )
const css = postcss.parse(
  fs.readFileSync(path.join(dist, 'app-origin.wxss'), 'utf8') + fs.readFileSync(path.join(dist, 'common.wxss'), 'utf8'),
)
function rule(selector) {
  const values = {}
  css.walkRules((r) => {
    if (r.selectors.includes(selector))
      r.walkDecls((d) => {
        values[d.prop] = d.value.toLowerCase()
      })
  })
  return values
}
assert.equal(rule('.status-image').width, '40px')
assert.equal(rule('.screen .navigation-row')['align-items'], 'center')
assert.equal(rule('.screen .navigation-row')['min-height'], '52px')
assert.equal(rule('.artwork-media')['aspect-ratio'], '1')
assert.equal(rule('.artwork-grid')['grid-template-columns'], 'repeat(2,minmax(0,1fr))')
assert.equal(rule('.bottom-action').position, 'sticky')
assert.match(rule('.bottom-action').padding, /safe-area-inset-bottom/)
assert.equal(rule('.staff-actions')['grid-template-columns'], 'repeat(2,minmax(0,1fr))')
// TEST-RESPONSIVE-001: check the emitted WXSS at each breakpoint. This is not a rendering test.
function atWidth(selector, width) {
  const values = {}
  css.walkRules((r) => {
    if (!r.selectors.includes(selector)) return
    for (let parent = r.parent; parent; parent = parent.parent) {
      if (parent.type !== 'atrule' || parent.name !== 'media') continue
      const minimum = parent.params.match(/^\(min-width:\s*(\d+)px\)$/i)
      if (!minimum || width < Number(minimum[1])) return
    }
    r.walkDecls((d) => {
      values[d.prop] = d.value.toLowerCase()
    })
  })
  return values
}
for (const width of [390, 820, 1024, 1280, 1440]) {
  const wide = width >= 1024
  assert.equal(atWidth('.page-content', width)['max-width'], '640px', 'customer reading width')
  assert.equal(
    atWidth('.staff-screen .page-content', width)['max-width'],
    wide ? '1440px' : width >= 768 ? '960px' : '640px',
  )
  assert.equal(atWidth('.staff-sidebar', width).display, wide ? 'flex' : 'none')
  assert.equal(atWidth('.staff-authorized', width)['padding-left'], wide ? '192px' : undefined)
  assert.equal(atWidth('.staff-mobile-navigation', width).display, wide ? 'none' : undefined)
  assert.equal(atWidth('.staff-task-screen .staff-mobile-navigation', width).display, 'none')
  assert.equal(
    atWidth('.checkout-payment', width).display,
    wide ? 'block' : 'contents',
    'narrow payment action keeps the full workspace as its sticky container',
  )
  for (const selector of ['.tables-workspace', '.checkout-workspace', '.inventory-workspace']) {
    assert.equal(atWidth(selector, width).display, wide ? 'grid' : undefined)
    if (wide) assert.match(atWidth(selector, width)['grid-template-columns'], /^minmax\(0,1fr\) (260|280|300)px$/)
  }
}
function bytes(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .reduce(
      (sum, item) =>
        sum + (item.isDirectory() ? bytes(path.join(dir, item.name)) : fs.statSync(path.join(dir, item.name)).size),
      0,
    )
}
console.log(
  `PASS: 17 compiled routes, 12 packaged artworks, native tab icons, layout rules at 390/820/1024/1280/1440px; build bytes ${bytes(dist)}`,
)
