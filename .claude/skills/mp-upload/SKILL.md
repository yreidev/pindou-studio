---
name: mp-upload
description: 编译小程序并上传体验版/发布版。当需要 build、preview、upload、发体验版、传一版、核体积表、或业主说「手机上看不到新功能」时使用。
---

# 小程序编译上传

## 主流程：打标签自动上传（2026-10-05 起）

`pindou-miniapp/package.json` 的版本号改成这次的版本、经 PR 合进 main（2026-10-31 起仓库公开，main 受保护，不能直接推），
在合并后的提交上打 `miniapp-v<版本>` 标签：`.github/workflows/miniapp.yml` 先核版本号、等 main 上的「工程验证」通过，
「上传体验版」任务停在 `production-build` 环境等审核，在 Actions 这次运行的页面点「Review deployments」批准后才读私有配置
（正式 AppID、接口地址）构建、用 miniprogram-ci（robot 1）上传体验版，「上传」那一步的日志里有各分包字节数和正式 AppID。
小程序和后端、网页后台各自发版（2026-10-31 起，`docs/plan-split-release.md`）：标签和 package.json 的版本不同就报错、不传；
以前共用的 `v<版本>` 标签（到 0.0.38）不再触发。密钥在 `production-build` 环境的 secret `WECHAT_MP_UPLOAD_KEY`（密钥文件全文）。
**改版本号、打标签就等于确认上传体验版**；正式版仍由业主在公众平台提审。体验版连正式后端：小程序要用新接口时先发后端。
只在正式版才调的新接口（如版本上报）可以先传体验版，但提审前后端必须先上线。
真机先验：本机 `make miniapp-preview` 出预览码给业主扫，确认后再打标签。公开仓库直接构建是示例配置，
要预览正式的，先在仓库外的一次性目录里用 `deploy/apply-store-config.py` 套上私有配置（见 `docs/deployment.md`）。

## 本机：miniprogram-ci（2026-10 起）

微信官方的 `miniprogram-ci`，工具在 `deploy/miniprogram/`（自己的 package.json，不混进小程序依赖）。每次从 `pindou-miniapp/dist` 重新打包，
**没有开发者工具的分包缓存、剔图片、关窗口这些问题**，也不用先 `cli quit`。

```sh
export WECHAT_MP_UPLOAD_KEY=~/.claude/credentials/wx-upload-touristappid.key   # 代码上传密钥（600），不进仓库
make miniapp-preview                     # 构建 + 预览：打印各分包字节数，预览码存 deploy/miniprogram/preview-qrcode.jpg
make miniapp-upload DESC="0.0.8：……"     # 构建 + 上传体验版；版本号取 pindou-miniapp/package.json
```

- 上传前同样先看体积表：`npm run size --prefix pindou-miniapp` 对照 preview 打印的字节数（判据见下文）。
- `mp.mjs` 会核对产物里内置的版本号和 package.json 一致，对不上（改了版本号没重新 build）就拒绝。
- 编译设置照搬 `dist/project.config.json`（es6、增强编译、压缩），和以前开发者工具传的包一致。
- **`invalid ip`（errCode -10008）**：公众平台「开发设置 → 小程序代码上传 → IP 白名单」是开着的。业主决定关掉白名单（GitHub Actions 的出口地址不固定）；
  显示「暂无」不等于关闭，空白名单会拒绝所有地址。
- 体验版自动跟最新上传（robot 1）。上传成功后到公众平台「版本管理」核对。

## 退路：开发者工具 CLI（miniprogram-ci 不可用时）


## 铁律：build 之后必须 `cli quit`

开发者工具**按分包缓存编译产物**。同一个 IDE 会话里连传两版，它会拿上一次会话的编译结果去打包，而且是分包级的——主包重编了、分包没有。

顺序不能变：

```
npm run build:weapp  →  cli quit  →  cli preview  →  核体积表  →  cli upload
```

中途再改代码，从 `npm run build:weapp` 重来一遍。**跳过 `quit` 等于可能传旧代码，且表面上一切正常。**

`cli quit` 会关掉业主开着的开发者工具窗口，**动手前先问业主**。

## 命令

CLI 在 `~/Applications/wechat-devtools-2.02/current/bin/wechat-devtools-cli`，`current` 是指向在用版本目录的软链接，升级只改它
（找不到就 `ls ~/Applications/ | grep -i wechat`）。

**换版本后先跑一次 `"$CLI" islogin`，确认它回的是 `{"login":…}` 而不是整页帮助。** 社区版 2.02.2608070-2 起 CLI 改由 Electron 冒充 node 运行，引导脚本 `bin/node` 少垫一个参数，Linux 上命令本身被切掉：`preview`/`upload` 都只打印帮助，**退出码仍是 0**。本机 2608080-1 已在 `bin/node` 里打了补丁（原文件 `bin/node.orig`），重装或升级会冲掉补丁，要重新打。

```sh
cd pindou-miniapp
npm run build:weapp

CLI=~/Applications/wechat-devtools-2.02/current/bin/wechat-devtools-cli
P=$PWD/dist

"$CLI" quit
"$CLI" preview --project "$P" --info-output /tmp/prev.json
"$CLI" upload  --project "$P" -v <版本号> -d "<说明>" --info-output /tmp/up.json
```

- **是 `--project`，不是 `-p`。** `-p` 会报 `project path / appid required (code 10)`，而且脚本退出码仍是 0，看着像跑过了。
- preview/upload 都是长命令，**后台起**（IDE 冷启动慢），日志写文件后用 Monitor 等 `ALLDONE`。
- **`quit` 后紧接着的第一次 preview 可能空等**：CLI 报「IDE server has started」后停在 `- Preview` 不动，
  实际 IDE 主程序没起来（端口上没人监听，新日志只有一行 `utility process exit!`）。结束那个 CLI 进程再跑一次 preview 就好
  （2026-10-04 传 0.0.2 时遇到，第二次 1 分钟内出结果）。preview/upload 用 `timeout 300` 包住，免得无限等。
- **本机 zsh 开了 `noclobber`**：`>` 覆盖已存在文件会直接失败、命令根本不执行，只留一个 `EXIT=1`。后台脚本先 `rm -f 日志文件` 或换新文件名。

## 体积表判据

`npm run size` 打本地产物体积，`--info-output` 的 JSON 里是开发者工具实际打的包。上传前对照。

- 整包级事故（资源被剔、整包旧编译）：差值 ±10% 以上，判据带 −1.3% ~ +9%，抓得出来。
- **单个文件没重编：差值只有几百到一千字节，判据抓不出来。** 所以靠的是流程（必 quit），不是体积表。
- 怀疑分包旧了，唯一能当场证实的办法：`cli quit` 后重新 preview，**看分包字节数变没变**。变了就说明之前传的是旧编译。

2026-09-20 实测（同会话连传 2.14.0/2.15.0，上次 quit 是 2.13.0）：

| 分包 | 会话内传的 | quit 重启后 |
|---|---|---|
| main | 720,303 | 720,303 |
| /pages/customer/ | 349,985 | **350,791** |
| /pages/staff/ | 154,536 | **155,550** |

## 版本号有两个来源，别混

- **应用内页脚** = 构建时从 `package.json` 读进 `src/version.ts`，编进主包共享 chunk `common.js`。
- **体验版面板** = `cli upload -v` 的参数，不碰已编好的代码。

不重新 build 直接换 `-v` 上传，两个数字就会对不上。要对上就改 `package.json` 再 `npm run build:weapp`。

**页脚版本号分辨不出分包新旧**——它在主包里，主包每版都因版本常量变化而重编，所以页脚永远诚实、分包可能是旧的。别拿页脚当分包的证据。

## 其他已知陷阱

- `dist/project.config.json` 的 `ignoreUploadUnusedFiles` 必须显式 `false`，否则只在运行时引用、或跨分包引用的图片会被剔掉。
- 开发者工具跑久了还会把主包图片当死文件剔掉（表现为主包 −17% 左右）。同样只有 `cli quit` 重启有效，`cache --clean compile`、`close/open` 都没用。

## 上传前的闸门

`npm run check`（tsc 零错误）、`npm test`（dist 存在时才跑得全，构建后再跑一次）、体积表对照。
