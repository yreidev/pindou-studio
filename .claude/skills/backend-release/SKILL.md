---
name: backend-release
description: 后端或网页后台发布到生产。当要部署后端、网页后台，上线新镜像、应用迁移时使用。
---

# 后端与网页后台发布

完整规则见 `docs/deployment.md`，本文只记实际操作顺序和验证判据。**执行前向业主确认目标环境**；微信凭证、服务器口令不经过助手。生产在单节点 k3s 上，命名空间 `pindou`：API 和网页后台页面服务（2026-10-31 起分开部署、各自发版，见 `docs/plan-split-release.md`）都在私有配置仓库的 `files/deploy/k3s/pindou.yaml`（发布只动它）；本仓库的 `deploy/k3s/` 只是示例，不能拿来部署。数据库清单发布不动（CloudNativePG，切换、恢复、升级见 `docs/deployment.md`「数据库（CloudNativePG）」）。

本仓库 2026-10-31 起公开：main 受保护，改动开分支、提 PR，「结论」检查通过后合并，不能直接推 main；发布标签只有管理员能打。发布任务（`release.yml`、`miniapp.yml`）核过版本、等到 main 上的「工程验证」通过后，构建那一步停在 `production-build` 环境等维护者审核，在 Actions 这次运行的页面点「Review deployments」批准后才读私有配置、构建、推镜像。

## 后端的顺序

1. **出镜像**：代码经 PR 合进 main（触发 `verify.yml`）→ 在合并后的提交上打 `backend-v<版本>` 标签并推送（到 0.0.38 为止是 `v<版本>`，现在不再触发）→ 批准 `production-build` 环境。`release.yml` 不重跑检查，等这个提交在 main 上的「工程验证」通过后推 `docker.io/yreidev/pindou-api:<版本>` 和 `sha-<7 位>`。**等这个工作流变绿再往下走。** 然后在私有配置仓库改清单里 API 镜像的标签、提交推送（只改清单不影响构建，`production-build` 里固定的配置提交不用跟着改）。
2. **先备份**：`kubectl -n pindou create job --from=cronjob/postgres-backup pre-<版本>`，`kubectl -n pindou wait --for=condition=complete job/pre-<版本> --timeout=10m`，`kubectl -n pindou logs job/pre-<版本> -c dump` 看到 `backup pindou_<时间>.dump done`（任务里已 `pg_restore --list` 验过；数据库换成 CloudNativePG 前后都适用，不用知道 Pod 名）。把 `/var/backups/pindou/postgres/` 里这份复制到 `/var/backups/pindou/manual/` 并拷回本机（定时任务 30 天后会清掉原件）。没验证过的备份不算备份。再记下此刻（UTC）：迁移出问题时可以按时间点恢复到发布前。
3. **应用**：先在服务器上 `k3s crictl pull docker.io/yreidev/pindou-api:<版本>`（缩短停机），用 `k3s crictl inspecti` 核对拉到的 digest 与工作流摘要里的 `digest:` 一致（标签可以被重推覆盖，digest 不会）；再把私有配置仓库的清单拷到服务器 `kubectl apply -f`，`kubectl -n pindou rollout status deploy/pindou-api`。两个副本滚动更新，不停机。
4. **验证**（缺一不可）：
   - `kubectl -n pindou get pods` 两个 API Pod 都 Ready
   - `/healthz` 返回的 `version` 等于这次的版本号（标签去掉 `backend-v`）、`commit` 等于这个标签的提交（`version` 是 dev 或 `commit` 带 `-dirty` 说明不是 CI 按标签出的产物，不能上生产）
   - `/readyz` 就绪
   - `goose_db_version` 的最新版本与 `internal/storage/migrations/` 里最新的文件对得上
   - 受影响的那条业务链路实际走一遍
   - 网页后台照常：`https://admin.example.invalid` 用小程序扫码登录一次，顶栏显示「实时 · 已连接」，首页「后端版本」是这次的版本
   - 顾客域名：`https://pindou.example.invalid/t` 是「请用微信扫码」那一页（手机相机扫网页桌码看到的就是它）
5. **退路**：`kubectl -n pindou rollout undo deploy/pindou-api`，并把私有配置清单里的标签改回去。**发布前先判断这一版能不能退**，并在测试库上实际起一次上一版确认：新迁移已执行、旧程序不认识新表结构时不能退；已付款订单会被退款改写，新版本给 `Order` 加了总会出现的 JSON 键时退回旧程序一退款就被拒（`TestPaidOrderShapeIsFrozen` 守着）；迁移 014 之后退不回 0.0.10 及更早（旧程序见到布局之外的桌拒绝启动），只能恢复备份。

迁移失败先判断兼容性，**不能靠重置生产库解决**。

## 网页后台的顺序

页面服务（`cmd/pindou-admin-web`，镜像 `docker.io/yreidev/pindou-admin`）不连库、不调微信；admin.example.invalid 的 `/api/`、`/healthz` 由 Traefik 转给 API，其余转给它。

1. **出镜像**：`pindou-admin/package.json` 的 `version` 经 PR 合进 main → 打 `admin-v<版本>` 标签并推送（和 package.json 的版本不同时 `release.yml` 报错、不出镜像）→ 批准 `production-build` 环境。等工作流变绿，再在私有配置清单里改 `pindou-admin` 镜像的标签。
2. **先备份**：同后端第 2 步（页面会调接口改数据）。
3. **应用**：`k3s crictl pull docker.io/yreidev/pindou-admin:<版本>`，核对 digest；`kubectl apply -f` 私有配置的清单，`kubectl -n pindou rollout status deploy/pindou-admin`（一个副本，先起新的再停旧的）。
4. **验证**：`pindou-admin` 的 Pod Ready；`https://admin.example.invalid` 打开是登录页、响应头带 `Content-Security-Policy`；扫码登录，首页「网页后台版本」是这次的版本和这个标签提交的前 7 位（`dev` 说明不是 CI 按标签出的，不能上生产）；受影响的页面走一遍。
5. **退路**：`kubectl -n pindou rollout undo deploy/pindou-admin`，并把私有配置清单里的标签改回去；页面服务不碰库，退回不受迁移限制。

## 发布前的闸门

```sh
cd pindou-backend && go test ./...
```

后端测试一律连真实 PostgreSQL：

```sh
make backend-test     # 没设 PINDOU_TEST_DATABASE_URL 时 go test 用 testcontainers 起 postgres:17.11-trixie（与生产同一镜像，要 docker）
make backend-sqlc-check   # sqlc 生成的代码与 internal/storage/queries/*.sql、schema.sql 一致
```

没有库时测试失败，不会再静默跳过；`PINDOU_SKIP_DATABASE_TESTS=1` 显式跳过时后端几乎什么都没测，不能拿来发布。退役某个列时要连它的约束一起退；迁移只做向后兼容的改动（先加后删），滚动更新时新旧版本同时运行。

## 验证时的坑

- **本机测不准**：本机代理会按域名把请求转走，`curl --resolve` 打到的可能根本不是目标服务器（2026-10-04 测一台还没有任何路由的机器，回了 200）。外网验证从不经代理的服务器发起。
- 存活检查只能是 `/healthz`。改清单时别把 `/readyz` 填进 liveness：数据库一抖 API 就被反复重启。
- preStop 的 8 秒等待别删：滚动更新时 Pod 被摘出端点和收到 SIGTERM 几乎同时发生，Traefik 跟上要几秒，没有这段等待会有请求打到正在退出的 Pod 上。
- 网络策略生效有几秒延迟，新 Pod 一启动就连库会被拒绝。API 启动时会重试连库（最多 1 分钟），备份任务先 `pg_isready` 等待；新加的、要连库的 Pod 也得这样。

## 记住

- 后端部署成功 ≠ 网页后台、小程序发布成功，各自分别确认（小程序见 `mp-upload`）。
- API 两个副本、`RollingUpdate`（`maxUnavailable: 0`）、PDB `minAvailable: 1`。进程不持有业务状态，扩副本只受数据库连接数限制。
- 财务不可改写由数据库触发器保证（`003_durable_records.sql` 的 `immutable_record` / `immutable_paid_order` / `immutable_paid_line`，`004_membership.sql` 另有会员流水的），别绕过。
- 迁移由 goose 按 `internal/storage/migrations/` 的版本号在启动时执行，文档不再写死编号；验证时对照 `goose_db_version` 与目录里的文件。新迁移以 `-- +goose Up` 开头，已发布的迁移不能改。
- 加环境变量要在 `cmd/pindou-api/main.go` 里校验取值，非法配置在连数据库之前就拒绝启动；值放进 `pindou-api-env` Secret，不能带引号。
