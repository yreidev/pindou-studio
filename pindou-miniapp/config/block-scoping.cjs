// 小程序产物里的 let / const 先由我们自己转成 var。
// 上传时微信的编译（miniprogram-ci、开发者工具，关掉「ES6 转 ES5」也照转）会把块里的 let / const 改成 var，
// 有时不改名：压缩后块里的变量常和外面的变量同名，提成 var 以后就把外面那个盖掉了。
// 2026-10-11 会员码出不来（qr.ts 顶层代码块的变量盖掉了异步助手）、2026-10-21 做图纸一直「正在转…」
// （取色函数里循环变量 a 盖掉了乘方助手 a = Math.pow，TypeError: a is not a function）都是这个原因。
// Babel 自己的块作用域转换会按需改名，转完产物里没有 let / const，微信那一步就碰不到这类变量。
const babel = require('@babel/core')
const blockScoping = require('@babel/plugin-transform-block-scoping')

/** 把一段打包好的代码里的 let / const 转成 var（按需改名）。 */
function lowerBlockScoping(code, filename) {
  const out = babel.transformSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: 'script',
    compact: true,
    comments: false,
    plugins: [blockScoping],
  })
  return out.code
}

module.exports = function blockScopingPlugin() {
  return {
    name: 'pindou-block-scoping',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') file.code = lowerBlockScoping(file.code, file.fileName)
        else if (file.fileName.endsWith('.js') && typeof file.source === 'string')
          file.source = lowerBlockScoping(file.source, file.fileName)
      }
    },
  }
}

module.exports.lowerBlockScoping = lowerBlockScoping
