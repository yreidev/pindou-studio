// Zod v4 加载时就会读这个全局配置，并在建对象校验规则时用 Function('') 试探能否动态编译来提速。
// 页面 CSP 不允许 eval（pindou-backend/internal/adminui：script-src 'self'），这一试探会被拦下，Firefox 还会报错。
// 必须在 Zod 加载之前设好：普通脚本先于模块脚本执行，所以放在 index.html 里单独引入，而不是在 main.tsx 里设。
globalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig || {}, { jitless: true })
