# 部署与私有构建配置

后端、员工网页后台、小程序独立发版，使用 `backend-v`、`admin-v`、`miniapp-v` 标签。发布前分别确认；后端部署前先备份，迁移保留经营历史。普通 PR 与工程验证只使用公开示例。

## 私有配置仓库

真实店名、Logo、字体子集、平面图和热区、原始已执行迁移、生产部署清单保存在独立私有仓库。该仓库不保存数据库密码、微信服务端密钥或上传私钥。

- `build-env.json`：`TARO_APP_ID`、`TARO_APP_API_BASE`、`TARO_APP_ADMIN_URL`、`TARO_APP_PRIVACY_VERSION`、`PINDOU_CUSTOMER_WEB_HOSTS`。
- `branding.json`：公开示例文字到正式品牌文字的映射，仅在发布构建源码中替换。
- `files/`：构建时按相对路径覆盖的门店素材、布局和历史迁移。两份 `store-layout.json` 必须一致，底图与热区一起更新。

在 **production-build Environment** 配置 `STORE_CONFIG_REPOSITORY`（`owner/repo`）与 `STORE_CONFIG_COMMIT`（完整提交 SHA），Secret `STORE_CONFIG_SSH_KEY` 使用仅允许读取该私有仓库的 SSH 部署密钥。Environment 只允许受保护的发布标签，启用维护者审核。私有仓库更新后需明确修改固定 SHA；不跟随分支最新提交。

本机先拉取已审核的配置提交到仓库外，再运行：

```sh
python3 deploy/apply-store-config.py /path/to/private-config
make frontend-build
make admin-binary
make backend-binary
```

脚本会改构建工作区并生成忽略提交的 `.env.production.local`；只在一次性构建目录执行，不能把生成的真实素材提交回来。Actions 把环境写入后续构建步骤，不打印值。

## 自动发布构建

先推 main 并通过「工程验证」，再打对应标签。`release.yml` 与 `miniapp.yml` 的发布任务从固定私有提交拉取配置，再构建正式产物；普通 PR 无权读取配置。发布任务不上传 Docker 构建记录。镜像仅包含运行程序与必要的前端资源，浏览者仍能从客户端或镜像观察公开运行所需的品牌和服务地址；私有配置用于隔离源码仓库中的信息，不把客户端配置当成密钥。

Docker Hub 推送使用 `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`，小程序上传使用 `WECHAT_MP_UPLOAD_KEY`；这些凭据放在受审核的发布 Environment Secrets。小程序正式发布仍由维护者在微信公众平台提审。

## 生产运行

从私有配置仓库的部署清单部署。API 运行时配置 `PINDOU_DATABASE_URL`、`PINDOU_WECHAT_APP_ID`、`PINDOU_WECHAT_APP_SECRET`、`PINDOU_CUSTOMER_WEB_HOSTS`；顾客域名显式设置，默认 `localhost` 仅供开发。预约通知的 `PINDOU_WECHAT_OPENID_KEY`、扫码规则的校验文件配置也通过部署 Secret 注入。数据库或微信凭据不进入镜像、日志或公开仓库。

API 与员工网页后台使用独立域名，接口与页面通过 Traefik 同源路由。API 不经 CDN，入口保留真实访客 IP。先备份并校验恢复条件，再滚动更新镜像，确认 `/healthz` 的版本与提交、`/readyz`、员工扫码登录与实时连接。数据库或原生微信验收未完成必须明确说明。

公开仓库中的 `deploy/k3s/` 仅为示例，不得直接用于真实门店。生产不能重置数据库或加载示例布局。公开迁移只清除了历史运维注释，SQL 语句不变；正式构建继续使用私有保存的原始已执行迁移，001–013 原始字节不改。
