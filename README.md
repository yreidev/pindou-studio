# Pindou Studio

单客户、单门店的拼豆/手作经营系统。顾客用微信小程序，员工用小程序和电脑上的网页后台，Go API 负责全部业务规则与 PostgreSQL 数据。只登记线下收款。后端、网页后台、小程序在同一个仓库，分开部署、各自发版（见 [分开发版](docs/plan-split-release.md)）。

## 项目说明

- [产品与当前进度](docs/product.md)：业务规则、权限、已实现能力和未完成事项。
- [开发约定](docs/development.md)：代码结构、数据安全、API 使用、小程序交互及代码测试。
- [部署与备份](docs/deployment.md)：部署方法、发布、备份恢复和微信联调。
- [API 契约](docs/api.yaml)：请求与响应字段的唯一来源。

文档只保留这几份，直接更新相关内容即可，不需要运行文档校验命令。协作规则见 [AGENTS.md](AGENTS.md)。

## 本地开发

`pindou-miniapp/` 使用 Taro 4、React、TypeScript，需要 Node.js 24+ 和 npm；`pindou-backend/` 的 Go 版本由 `go.mod` 的 `toolchain` 行指定。环境配置、数据库与真机联调见 [开发约定](docs/development.md#本地运行与配置)。

```sh
npm ci --prefix pindou-miniapp
make frontend-dev
```

运行 `make` 或 `make help` 查看全部命令。另开终端用 `make backend-dev` 启动 API，默认监听 `127.0.0.1:8080`，可通过 `PINDOU_HTTP_ADDRESS` 覆盖；微信与数据库配置沿用环境变量。`make test` 只运行前后端测试，`make frontend-build` 构建微信小程序。

在微信开发工具中打开 `pindou-miniapp/project.config.json` 所在目录。Linux 使用社区适配工具，真实编译、预览和上传需现场确认。

修改代码后按影响范围运行包内检查；前后端一起改时使用 `make verify`。该命令验证后端、小程序和网页后台，不包含文档门禁；后端数据库测试连 `PINDOU_TEST_DATABASE_URL`，没设时测试自己用 testcontainers 起库（要 docker），没有库时失败而不是跳过（见[开发约定](docs/development.md#代码验证)）。

当前小程序 23 页，员工支持手机、平板和电脑版微信窗口；按座独立计时、套餐计价及部分真实微信验收仍未完成。运行所需图片保存在小程序 `src/assets/`，旧设计稿与素材已移出仓库。

## 公开范围与许可

代码公开供浏览，暂不授予复用、修改或再分发许可，详见 [LICENSE](LICENSE)。GitHub 平台上的浏览和 fork 权利遵循其服务条款。第三方字体、图标、模型和测试图片按各自许可分发。

仓库中的名称、Logo 和平面图是虚构示例。真实门店素材与构建配置保存在独立私有仓库；发布构建使用只读部署密钥按固定提交拉取。普通 PR 检查只使用示例，不接触私有配置或生产凭据。见[部署与构建配置](docs/deployment.md)。
