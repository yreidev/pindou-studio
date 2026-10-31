import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

// Type-aware linting over the app sources. The Vitest unit tests under tests/
// are TypeScript checked with the untyped rules; the remaining CommonJS scripts
// there (WXSS compiler, static and DevTools checks) use the plain JS rules.
export default tseslint.config(
  {
    // src/api/schema.d.ts 由 npm run api:types 从 docs/api.yaml 生成，不归 lint 管。
    ignores: ['dist/**', 'dist-h5/**', 'node_modules/**', 'miniprogram_npm/**', '.swc/**', 'src/api/schema.d.ts'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The plugin's `recommended` set now also carries the React Compiler era
      // rules (set-state-in-effect, refs, ...), which encode React 19
      // expectations. This app is React 18 on Taro 4, so only the two classic
      // rules are enforced; revisit the rest along with any React 19 upgrade.
      'react-hooks/rules-of-hooks': 'error',
      // The API client returns parsed JSON payloads that the pages narrow at the
      // point of use; docs/api.yaml is the contract for their shape. Requiring a
      // nominal type for every response body would duplicate that contract in
      // TypeScript without catching anything it does not already pin down, so
      // the rules that police `any` flowing out of the client are off together.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Misjudges assertions placed on `any`-returning platform APIs such as
      // Taro.getStorageSync: it reports them as no-ops, and removing them drops
      // the only declared shape the call site has.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // Stale-closure risks worth seeing but not worth failing a build over:
      // several are the known ref-cleanup false positive.
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 开发者工具转 ES5 时把模块顶层 { let … } 块里的变量改成 var 却不改名，压缩后会和同文件的
      // 顶层变量撞名、把它覆盖掉（2026-10-11 会员码页因此一个请求都发不出去，见 services/qr.ts）。
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Program > BlockStatement',
          message: '模块顶层不要写 { } 代码块，改成函数：开发者工具转 ES5 后块里的变量会覆盖同名的顶层变量。',
        },
      ],
    },
  },
  {
    // Unit tests run under Vitest. Their doubles are loose objects standing in
    // for platform and service modules, so `any` is allowed here as in src.
    files: ['tests/**/*.{ts,tsx}', 'vitest.config.mts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Build-time tooling and end-to-end capture scripts run by node directly,
    // outside the Taro bundle. tests/e2e/ drives the WeChat devtools over the
    // automation port; it is deliberately not part of `npm test`, which must
    // stay runnable without the IDE.
    files: ['scripts/**/*.mjs', 'tests/e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    files: ['tests/**/*.cjs', 'config/**/*.cjs', '*.config.js', '*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
        // Injected by the WeChat runtime inside mini.evaluate() callbacks.
        getApp: 'readonly',
      },
    },
  },
)
