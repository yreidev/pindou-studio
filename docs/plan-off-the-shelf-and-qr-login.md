# 用现成技术栈替换手写部分，网页后台改用微信扫一扫登录（计划与进度）

0.0.7 之后的一批（2026-10-05 业主要求全部做）。原则：成熟、维护活跃、贴合现有架构的才换；
本系统的核心设计（请求事务与工作集、幂等、按事件推送）和体量很小的部分（微信接口客户端、小程序实时连接、
门店时区固定偏移、小程序自有设计的 UI 组件）保持手写。

## 要换的

| 范围 | 现在 | 换成 | 要点 |
|---|---|---|---|
| 小程序上传/预览 | 开发者工具图形界面的 CLI | 官方 `miniprogram-ci` | 不开开发者工具；能在 CI 里传体验版。需要业主在公众平台生成「代码上传密钥」并处理 IP 白名单 |
| 网页后台登录 | 页面上的普通二维码，要先进小程序再扫 | 小程序码（`getwxacodeunlimit`），微信扫一扫直达批准页 | scene 为去掉连字符的挑战编号；env_version 跟桌码同一个配置；生成失败时退回原来的二维码 |
| 接口类型 | 三端照 `docs/api.yaml` 手写 | TS：`openapi-typescript`（网页后台另加 `openapi-fetch`）；Go：测试里用 `libopenapi-validator` 按契约核对每个请求与响应 | Go 不生成类型：oapi-codegen 不支持 OpenAPI 3.1，契约不退回 3.0；请求、响应两头都核对，结构体与契约照样绑住 |
| 路由 | 手拆路径 + `switch` | 标准库 `ServeMux` 的方法与路径模式 | 不加依赖 |
| WebSocket | 手写握手与帧 | `github.com/coder/websocket` | 子协议传令牌、主动心跳的约定不变 |
| gzip | 应用里手写 | Traefik `compress` 中间件 | 删应用里的实现 |
| XLSX 导出 | 手拼 zip 与 XML | `github.com/xuri/excelize/v2` | 文件内容与现有测试的断言对齐 |
| 迁移执行 | 手写执行器 + `schema_migrations` | `pressly/goose`（只向上、会话级咨询锁） | 首次运行把已有的 `schema_migrations` 登记过去，不重跑 |
| 测试库 | 手写模板克隆 + Makefile 起容器 | `pgtestdb` + `testcontainers-go` | `go test` 自己起库 |
| 固定 SQL | 字符串 | `sqlc` 生成 | 动态拼条件的搜索、按集合写回保持手写 |
| 网页后台接口客户端 | 手写 fetch 封装 | `openapi-fetch` | 幂等键、错误中文化的逻辑保留 |
| 网页后台实时重连 | 手写 | `partysocket` | |
| 小程序数据读取 | `useStaffData`、`useServerSearch` 自管状态 | `@tanstack/react-query` | 前后台切换、网络恢复接到 Taro 的事件上 |
| 小程序单元测试 | 手写转译与依赖注入 | Vitest | |
| 数据库与备份 | 手写 StatefulSet + 每天 `pg_dump` | CloudNativePG：WAL 连续归档、按时间点恢复 | COS 暂不接（业主决定），先归档到本机的 rclone S3 服务；切换要一次计划停机（彩排约 40 秒）。每天的 `pg_dump` 保留 |
| 外部监控 | 巡检脚本，只手动触发 | 暂缓（业主 2026-10-05 决定暂不加，定时巡检也先关） | |

## 需要业主提供

- 小程序「代码上传密钥」：已提供（本机凭据目录），IP 白名单已关闭。
- 腾讯云 COS：暂不接。
- 外部监控：暂不加。

## 进度

- [x] 0.0.7 发布与小程序验收、上传
- [x] 小程序上传改 `miniprogram-ci`（`deploy/miniprogram`、`make miniapp-preview/upload`；0.0.8 起用它上传）
- [x] 网页后台微信扫一扫登录（0.0.8：后端 2026-10-05 15:28 上线，小程序 0.0.8 体验版已传；待真机扫码验收）
- [x] 契约生成类型与校验：网页后台、小程序的类型由契约生成（`api:check` 核对是最新的），小程序手写的宽松类型在 `src/api/contract-check.ts` 编译期核对契约；后端测试按契约核对每个请求与响应、要求每个接口都测到
- [x] 路由、WebSocket、gzip、XLSX（待上线后核对：小程序真机实时连接的 Ping 心跳、微信里打开导出的 xlsx、Traefik 压缩生效且事件流不被缓冲）
- [x] 迁移、测试库、sqlc
- [x] 网页后台接口客户端与实时重连
- [x] 小程序数据层与单元测试（代码与单元测试完成；开发者工具与真机验收待做，重点是真机上的读取、定时刷新与前后台切换）
- [x] 0.0.10 发布：后端滚动更新（上面换掉的路由、WebSocket、goose、sqlc、XLSX，加 `/statusz` 的 WAL 归档状态；清单带 Traefik 压缩中间件），小程序上传（TanStack Query、生成的类型、停用桌位后平面图仍可约）。已彩排：pre-0.0.9 生产备份上 0.0.9 → 0.0.10 → 回退 0.0.9 → 再升级都能读写，goose 接管迁移记录不重跑；造数据后两版 41 个读接口严格比对无差异；两种认证的事件流都通
- [x] CloudNativePG 与连续归档：清单、国内拉镜像的办法、本机彩排（切换、按时间点恢复、退回旧库，`deploy/cnpg-rehearsal.sh`）
- [x] CloudNativePG 生产切换（2026-10-05）：切换前用 0.0.11 之后的生产备份重跑了彩排；生产停机 39.9 秒（外部探测不可用 37 秒），指纹只有 superuser 一行不同，归档与基础备份正常。旧 StatefulSet 已缩到 0、数据卷留作退回
- [x] 删掉旧库（2026-10-06，业主决定提前清理）：StatefulSet、服务、网络策略和数据卷已删，数据目录存档后删除；`pindou-db.yaml` 去掉导入配置，`legacy-postgres.yaml` 删除，彩排脚本改为从零建库
- [x] `/statusz` 报告 WAL 归档：`walArchive` 读 `pg_stat_archiver`，归档卡着时 `failing` 为真、巡检脚本报警。基础备份的完成时间数据库层面查不到，在服务器上看 `kubectl -n pindou get backups`
- [ ] 外部监控（暂缓）
