const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const postcss = require('postcss')

const root = path.resolve(__dirname, '..')
const sources = fs.readdirSync(path.join(root, 'src'), { recursive: true }).filter((name) => name.endsWith('.tsx'))
let consumers = 0
for (const file of sources) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(path.join(root, 'src', file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    )
      continue
    const module = statement.moduleSpecifier.text
    const button = statement.importClause.namedBindings.elements.some(
      (item) => (item.propertyName || item.name).text === 'Button',
    )
    if (!button) continue
    if (module === '@tarojs/components')
      assert.equal(file, 'components/button.tsx', `native button bypasses shared reset: ${file}`)
    else if (module.endsWith('/button')) consumers++
  }
}
assert.ok(consumers >= 17, 'page and shared buttons must use the native reset')

const css = postcss.parse(fs.readFileSync(path.join(root, 'dist/app-origin.wxss'), 'utf8'))
function declarations(selector) {
  const values = {}
  css.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return
    rule.walkDecls((declaration) => {
      values[declaration.prop] = declaration.value
    })
  })
  return values
}
assert.equal(declarations('.ui-button')['box-sizing'], 'border-box')
assert.equal(declarations('.ui-button').margin, '0')
assert.equal(declarations('.ui-button').padding, '0')
const after = { ...declarations('.ui-button::after'), ...declarations('.ui-button:after') }
assert.equal(after.border, '0', 'compiled reset must target the real native button class, not .h5-button')
const command = declarations('.screen .button')
assert.equal(command['align-items'], 'center')
assert.equal(command['justify-content'], 'center')
assert.equal(command['line-height'].toLowerCase(), '24px')
assert.equal(command.padding.toLowerCase(), '10px 16px')
assert.equal(command['min-height'].toLowerCase(), '48px')
assert.equal(declarations('.input')['box-sizing'], 'border-box')
console.log(`PASS: ${consumers} shared-button consumers and native WXSS frame, padding and alignment rules`)
