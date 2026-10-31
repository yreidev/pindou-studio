---
name: wx-acode
description: 生成微信小程序码（桌码）。当涉及 getwxacodeunlimit、桌码生成失败、errcode 41030 invalid page 时使用。
---

# 微信小程序码 / 桌码

实现在 `pindou-backend/internal/modules/identity/infrastructure/wechat/client.go` 的 `TableCode`（网页后台登录码是同一个文件的 `WebLoginCode`），指向的版本由调用方每次传进来。

## errcode 41030 `invalid page` 的三个原因

1. **`page` 路径写错。** 必须是分包后的真实路径 `pages/customer/experience/index`，不是 `pages/experience/index`。改分包结构时这里会悄悄变陈旧。
2. **`check_path` 默认是 `true`，省略 ≠ 关闭。**
   必须显式给值：`"check_path": env == EnvRelease`。
   曾经为了「非 release 不校验」而把字段省掉，微信照样去校验、照样回 41030。测试要断言**字段存在且为 false**，不是断言字段不存在——后者等于给 bug 背书。
3. **目标版本里没有这个页面。** `env_version` 指向哪个版本，微信就去哪个版本里找 `page`。

## 指向的版本：网页后台「桌码」页的设置（0.0.24 起）

取值 `release` / `trial`（没改过时的默认）/ `develop`，存在 `miniprogram_code_settings`（迁移 023），接口 `/system/code-settings`。它决定顾客扫桌码、员工扫网页后台登录码打开哪个版本，也决定微信去哪个版本校验页面。以前的环境变量 `PINDOU_WECHAT_TABLE_CODE_ENV` 已不再读（还设着时启动日志会提醒）。

- 只有老板能改，要写原因（审计 `miniprogram.env_changed`）、勾选确认。保存前后端用新版本试生成一次桌码和登录码，微信回 errcode 就 409 `code_check_failed`、不保存——正式版没发布时改成 `release` 会在这里被拦下。
- **改成 `develop` 拦不住**：非 release 不校验路径，微信照样出码，但只有小程序开发者能打开，员工扫不了登录码。只在调试时临时用。
- 2026-10-20 正式版发布后，老板已在「桌码」页最下方改成正式版。

## 其他

- scene 是**去掉连字符**的桌位 UUID（前端 `src/services/table-code.ts` 的 `tableIdFrom` / `withDashes`）。登录跳转必须保留 `tableId`/`scene`。
- 微信返回的错误要把 errcode/errmsg 原样透出来，否则排查时只能看到一句「生成失败」。
- 曾经做过后端自绘的「内码」（boombuler/barcode）作为退路，微信码跑通后已删除，不要再引回来。
- 桌码是低频功能，只在网页后台生成和打印（小程序员工端的桌码页已删）。
- 网页后台 `/table-codes`（`pindou-admin/src/routes/_authed/table-codes.tsx`）按区域列出桌位，批量生成时**逐张**请求（不并发，免得撞微信频率限制），单张失败只标在那一行，可单独重试；生成后浏览器直接打印。
