---
name: mp-add-page
description: 小程序新增页面。当要加一个新页面、新路由，或点击入口莫名跳回首页时使用。
---

# 小程序加页面要动四处

漏掉任何一处都**不报错**，只是行为不对。

1. **`src/app.config.ts`** — 加进对应 `subPackages[].pages`。
   分包只有三个：`pages/customer`、`pages/staff`、`pages/developer`。加错分包不会报错，但包会变大、加载时机也错。
2. **`src/services/staff-navigation.ts` 的 `staffDestinations()`** — 员工页要出现在工作台/侧栏入口里。
3. **`src/services/navigation.ts` 的 `fallbackPage()`** — 定这一页的返回落点（员工页默认回工作台，顾客页回首页）。
4. **`src/services/navigation.ts` 顶部 `allowed` 这张 Map** — `sanitizeTarget()` 的白名单。
   **漏了这一条最坑**：`navigateApp()` 会静默把目标改写成首页，用户点了按钮跳到首页，控制台什么都不说。

## 验证

`tests/navigation.test.ts` 里钉死了路由总数（当前 `assert.equal(routes.length, 21)`）。加页面、删页面都要同步改这个数字——它就是用来抓「改漏了 / 改重了」的。删页面同样要动这四处，并在 `tests/responsive.test.ts` 核对员工导航项。

2026-09-20 一次 `sed` 把同一页同时塞进了 customer 和 staff 两个分包，就是这条断言（25 ≠ 23）抓出来的。

给新入口加一条导航测试时，**先确认它在没打白名单的情况下真的会失败**，再去改白名单。不会失败的测试等于没写。

```sh
cd pindou-miniapp && npm run check && npm test
```
