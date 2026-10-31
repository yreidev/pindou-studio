# 开发约定

业务范围和待办见 [产品说明](product.md)，请求响应以 [API 契约](api.yaml) 为准。修改相关行为时一起更新对应内容；普通文档修改不需要执行命令或通过专门 CI。

## 工程结构

- `pindou-miniapp/`：Taro 4.2.1、React 18、TypeScript、Sass、Vite，唯一业务客户端。页面位于 `src/pages/`，API 客户端位于 `src/services/customer.ts` 和 `staff.ts`，读接口数据用 TanStack Query（见下文「小程序读数据」），导航与离开保护集中在 services/hooks，共用组件与样式在 components/styles。单元测试用 Vitest，在 `tests/`。
- `pindou-admin/`：员工电脑网页后台，React 19、Vite、TypeScript、pnpm；组件库 Semi Design（`@douyinfe/semi-ui`，入口最先引入 `@douyinfe/semi-ui/react19-adapter`；默认主题），TanStack Query/Router/Form/Pacer，接口客户端 openapi-fetch，实时重连 partysocket。路由在 `src/routes/`（文件即路由，`routeTree.gen.ts` 由 check/build 生成、不入库），接口客户端 `src/api/`，实时连接 `src/realtime/`。构建产物由 `make admin-embed` 复制进 `pindou-backend/internal/adminui/dist`，再 `go:embed` 进 `cmd/pindou-admin-web`，独立镜像、独立部署；Traefik 把同一域名的接口转给 API，不需要 CORS。本机开发与端到端由 `cmd/pindou-dev` 同时提供页面和接口。
- `pindou-backend/`：Go（版本见 `go.mod`）、标准库 HTTP、pgx/PostgreSQL 模块化单体。现有路由和部分编排集中在 `internal/app`，路由表在 `routes.go`（标准库 `ServeMux` 的方法与路径模式，每条接口登记时写明只读/可写事务、提交后推送的资源名和是否限流）；identity、tables、orders、catalog 等模块在 `internal/modules/`，持久化实现位于 `internal/modules/persistence/`，迁移与事务支持在 `internal/storage/`。
- 新增或调整功能保持 Handler 处理 DTO/错误映射、application 处理业务和事务、repository 处理 SQL、domain 不依赖 HTTP/数据库。按实际需要抽取，不为补齐目录创建空层，不预建共享包或微服务；生成代码只用在两处：接口类型由 `docs/api.yaml` 生成（网页后台与小程序各自的 `src/api/schema.d.ts`；小程序只取类型、请求仍走 `Taro.request`，比契约宽松的手写类型由 `src/api/contract-check.ts` 编译期核对），固定 SQL 由 sqlc 生成（`internal/storage/queries`），生成结果入库、CI 检查是否过期。

Taro 4 当前依赖 Vite 4，样式通过 `config/modern-sass.cjs` 调用 Sass 现代 API，再交给 Vite/PostCSS 处理，避免旧 JS API 弃用警告。升级到原生支持现代 Sass API 的兼容构建链后可移除此适配。

`npm audit` 当前报告 55 项依赖告警，除端到端脚本用的 `miniprogram-automator` 所带图片库的一项外，全部位于 Taro 4 的构建链（`@tarojs/cli`、Vite、esbuild、下载与解压工具等）。npm 给出的"修复"是把 Taro 降回 3.x、`@tarojs/cli` 降到 1.3.8 或 Vite 升到 8，都会拆掉现有构建链，不予采纳。已核对微信构建产物：告警包的实现代码未进入 `dist/`，其中 `swiper` 仅以 Taro 原生组件名字符串出现，库本体未打包。构建期依赖的风险边界是开发机与 CI，不是线上小程序；随 Taro 官方升级一并处理，不单独降级。 顾客网页（Taro 网页版）多出的 6 项不同：`@tarojs/taro-h5`、`@tarojs/components-react` 等运行时代码真的进了浏览器的包，2026-10-10 逐项核对过：`swiper`（原型污染）是组件库的总导出连带打进来的，业务代码不用轮播、它从不被实例化；`lodash-es` 的 `_.template` 没进包；网页运行时里的 `decode-uri-component` 是 0.5.0，不在受影响范围（0.2.2 只在构建工具链里）。Taro 锁死了这些版本，随 Taro 官方升级处理，不单独覆盖版本。

依赖的安装脚本由 `pindou-miniapp/package.json` 和 `deploy/miniprogram/package.json` 的 `allowScripts` 管，现有的全部记为 `false`：esbuild、@swc/core 的脚本只在预编译二进制缺失时联网补装（二进制已随可选依赖装好），@tarojs/binding、@parcel/watcher 的只在要求从源码编译时才动作，core-js 打印广告，less、protobufjs 的只服务它们自己的开发与命令行工具，@tarojs/cli 的会联网往全局装京东的构建性能上报插件；不跑它们构建产物不变，装出的文件只差 esbuild 的命令行入口没换成原生程序。npm 11 对没登记的包照样执行并在安装末尾列出，npm 12 起默认不执行。新增依赖后出现 `install-scripts` 提示，先看脚本做什么，确实需要才 `npm install-scripts approve <包>`，否则 `deny`。`npm ci` 剩下的 deprecated 提示都在上游锁死的版本里：小程序是 Taro 的 `@tarojs/plugin-doctor`（eslint 8、glob 10，构建时会加载，用的是 eslint 8 的接口）、`@tarojs/helper` 固定的 `@swc/register`、`scss-bundle` 带的 glob 7 与 inflight，以及 jimp 带的 phin（`overrides` 已把 `miniprogram-automator` 的 jimp 换到 0.22、rimraf 统一到 6）；上传工具的全部来自 `miniprogram-ci` 2.1.31（最新正式版）。Taro 4.3.0 仍带着这些依赖，随官方升级处理，不硬改。

静态检查：后端 `.golangci.yml`、小程序 `eslint.config.mjs`、网页后台 `pindou-admin/eslint.config.js`，分别由 `make backend-lint`、`make frontend-lint`、`make admin-lint` 执行，`make verify` 已包含。golangci-lint、govulncheck、sqlc 的版本只写在 Makefile，`make backend-tools` 一次装好（CI 按这几个版本加 Go 版本缓存编好的程序）。golangci-lint 只能分析不新于其构建工具链的 Go 代码，因此 `make backend-lint` 固定使用 `go.mod` 的 `toolchain` 行，golangci-lint 本身也要用不旧于这一版的 Go 编译（所以从源码装，不用官方预编译的程序）。Go 的补丁版本也可能升级编译器导出数据的格式（1.27.2 升到 V5），这时 golangci-lint 还要升到它所带 x/tools 认得新格式的版本，否则 lint 报一串 `could not import …`（typecheck），换 Go 编译它也没用。ESLint 关闭了针对 API 响应 `any` 的规则（契约以 `docs/api.yaml` 为准），`react-hooks` 只启用与 React 18 对应的经典规则，`exhaustive-deps` 记为警告不阻断构建。

## 本地运行与配置

Node 版本以根目录 `.nvmrc` 为唯一来源、写到补丁版本（如 `24.21.0`），CI 通过 `node-version-file` 读同一文件；本机 `nvm install` 这一版即可，`make` 的命令会自动优先用它（不改本机默认的 Node），`make verify` 开头核对版本，不一致就停。跟进 Node 安全补丁时改这一行（Dependabot 不管 `.nvmrc`）。Go 版本同样只由 `pindou-backend/go.mod` 声明：`go` 行是语言版本，`toolchain` 行是实际编译、测试和 CI 使用的工具链（本机更旧时 `go` 命令会自动下载）。升级 `toolchain` 跟进 Go 安全补丁；生产二进制也须用这一版编译。在仓库根目录运行 `npm ci --prefix pindou-miniapp` 安装依赖，`make frontend-dev` 持续构建微信小程序，另开终端执行 `make backend-dev`。微信开发工具打开 `pindou-miniapp/project.config.json` 所在目录，构建产物位于 `pindou-miniapp/dist/`。只构建微信端，不再维护 H5：界面与授权一律在微信开发工具或真机验证。全部命令见 `make help`。

后端只跑在 PostgreSQL 上，没有不落库的模式。`make backend-dev` 运行 `cmd/pindou-dev`：没设 `PINDOU_DEV_DATABASE_URL` 时先起本机容器 `pindou-dev-pg`（PostgreSQL 17，与生产同一镜像，端口 55431），在其中建库 `pindou_dev`（不存在才建，数据留到 `make dev-db-reset`），启动时自动迁移，默认监听 `127.0.0.1:8080`，可用 `PINDOU_HTTP_ADDRESS` 覆盖。它固定使用**假微信**（`PINDOU_DEV_FAKE_WECHAT=1`）：登录码直接当身份、手机号原样收下，所以只能连本机或测试用的数据库服务器，不能指向生产。`pindou-dev -fresh -db 名字` 先删后建、退出时删库，网页端到端测试用的就是这个。

直接运行 `go run ./cmd/pindou-api` 时必须设 `PINDOU_DATABASE_URL`，默认监听 `:8080`；微信要么成对配置 `PINDOU_WECHAT_APP_ID`、`PINDOU_WECHAT_APP_SECRET`，要么显式 `PINDOU_DEV_FAKE_WECHAT=1`，二者不能同时出现，缺了就拒绝启动。旧的 `PINDOU_DEV_STORAGE` 已删除，设了会直接报错。生产运行方式见 [部署说明](deployment.md)。

服务启动时自动迁移数据库（数据库未就绪时最多等一分钟；多个副本同时启动时用咨询锁排队，只有一个执行），`curl http://127.0.0.1:8080/healthz` 检查服务是否可达，返回中的 `commit` 是构建所用的提交，本地从未提交的工作区构建时带 `-dirty`。没有开发老板 HTTP 登录入口，新环境首位老板初始化见部署说明；本地开发可用 `PINDOU_BOOTSTRAP_OWNER_ID` 或开发者白名单。

网页后台：`pnpm --dir pindou-admin install --frozen-lockfile` 安装依赖（pnpm 版本见 `pindou-admin/package.json` 的 `packageManager`，现为 11；pnpm 设置写在 `pindou-admin/pnpm-workspace.yaml`，不写在 package.json），`make backend-dev` 起后端后另开终端 `make admin-dev`，浏览器打开 Vite 给出的本地地址；`/api` 与 `/healthz`（含实时 WebSocket）代理到 `PINDOU_ADMIN_BACKEND`，默认 `http://127.0.0.1:8080`。登录只有扫码：开发后端用的是假微信、生成不了小程序码，登录页会退回普通二维码，用连着同一后端的小程序员工身份在「现场 › 连电脑」点「扫登录码」扫码并允许。直接访问 `make backend-dev` 的非接口路径时，没执行过 `make admin-embed` 会显示「网页后台未构建」。

小程序的 `TARO_APP_API_BASE` 是构建时 API 地址，未配置时回退到 `http://127.0.0.1:8080/api/v2`；正式构建使用已登记的 HTTPS 域名。`TARO_APP_PRIVACY_VERSION` 必须与实际发布的微信隐私协议版本一致，开发默认值为 `wechat-privacy-v1`；正式构建从私有配置注入 `TARO_APP_API_BASE`、`TARO_APP_ADMIN_URL`、`TARO_APP_PRIVACY_VERSION` 和 `TARO_APP_ID`，公开项目配置使用游客 AppID。小程序用到的隐私接口都要在指引里声明，没声明的会被微信直接拦下（报 `api scope is not declared in the privacy agreement`）：现在要有微信昵称和头像、手机号、选中的照片或视频信息、相册（仅写入）、剪切板、选中的文件。扫码、`openLocation` 导航、打电话、订阅消息、`shareFileMessage` 发文件不在微信的隐私接口清单里，不用声明（以官方「小程序用户隐私保护指引内容介绍」为准，2026-07-28 版）。微信取号按钮见下文「小程序交互与视觉」。

局域网真机调试在忽略提交的 `pindou-miniapp/.env.local` 设置 `TARO_APP_API_BASE=http://电脑局域网IP:8080/api/v2`，运行 `make frontend-build`。后端用 `PINDOU_HTTP_ADDRESS=0.0.0.0:8080 make backend-dev` 或绑定开发机局域网地址；手机与电脑同网段，防火墙允许局域网 TCP 8080。手机上的 `127.0.0.1` 指手机本身，微信工具的 8001 是调试通道。开发工具可临时关闭合法域名校验；电脑 IP 变化后更新配置并重建，正式验收恢复 HTTPS 域名校验。

### 顾客域名与网页后台服务

顾客网页 2026-10-31 下线（见 [分开发版](plan-split-release.md)），小程序代码只编微信版，没有网页版分支。顾客域名（`PINDOU_CUSTOMER_WEB_HOSTS`，生产 `pindou.example.invalid`）下后端只给接口、微信的校验文件和一页「请用微信扫码」（`internal/app/customer_host.go`，根路径和 `/t`，不带脚本、CSP 只放行它自己的内联样式），其余 404；别的域名下非接口路径 `cmd/pindou-api` 一律 404。生产的网页后台页面由 `cmd/pindou-admin-web` 提供（`make admin-binary` 先构建页面再编进它，`make admin-image` 出镜像），它和 `cmd/pindou-dev` 都用 `internal/webui` 托管 `internal/adminui` 里嵌入的页面。

本机：`make backend-dev`（或 `cmd/pindou-dev`）在同一端口同时给接口和网页后台页面，`http://localhost:8080` 是顾客域名（`PINDOU_CUSTOMER_WEB_HOSTS` 默认 `localhost`，`/t` 是「请用微信扫码」），`http://127.0.0.1:8080` 是网页后台（先 `make admin-embed`）。

## 数据与安全

金额使用整数分，折扣使用整数基点，禁止浮点运算；数据库金额为 BIGINT、时间为 TIMESTAMPTZ、主键为 UUID，没有租户或门店隔离字段。元输入精确转换，拒绝多余小数与溢出；客户端只格式化服务端金额。

资金、折扣和库存写入必须在数据库事务中消费 `Idempotency-Key`。已付款订单及明细、付款、退款、采购、库存流水、折扣和审计不可随意改写或删除；修正须冲正。角色变更、最后老板校验和审计也在同一事务中完成。事务提交成功后才发布资源事件。

PostgreSQL 是业务数据的唯一来源，进程不持有业务状态，任何一个副本都能处理任何请求。每个请求一个数据库事务（`internal/app/httpx.go` 的 `serveTx`）：写请求 SERIALIZABLE，读请求 REPEATABLE READ 只读；数据库报串行化冲突、死锁或唯一键冲突时整个请求从头重来（最多 10 次，带抖动退避），所以请求体先整段读进内存、响应先写进缓冲，提交成功才发给客户端；状态码不是 2xx 时回滚。处理函数 panic 时回滚并回 500 `internal_error`；数据库按约束或不可改写触发器拒收（SQLSTATE 22、23 类除唯一键冲突、P0001，说明应用层漏了校验）不重试，回 500 `persistence_rejected`；其余数据库故障或冲突重试用完回 503 `persistence_failed`（可以再试）。没有可被带走的全局锁。

处理函数通过请求事务 `q := s.tx(r)` 读写（`internal/app/txn*.go`）：`q.order(id)` 之类按需从库里读出并放进本次请求的工作集，同一条记录一个请求里只有一个实例；改完不用手动保存，提交前按 JSON 比较找出变化的记录，经 `records.SaveCollection` 写回（新建的用 `q.add…`）；查询前先把已改动的记录写回，保证查到的是最新的。会员资产按顾客整份读入（规则、草稿、发布记录整份），写回时动到没读入的顾客会 panic，防止只改了一半。微信等外部调用一律在事务外完成，事务重试时不会重复调用。

写法固定的 SQL 放在 `internal/storage/queries/*.sql`，由 sqlc 生成 Go 代码（同目录，提交进仓库；配置 `pindou-backend/sqlc.yaml`）。处理函数里用 `must(q.db().查询名(q.ctx, …))`：`q.db()` 先写回改过的记录再给出跑在请求事务上的查询，写语句用 `q.dbWrite()`（只读请求里写会 panic），读完整记录的查询选出 `id`、`state` 两列，交给 `adopt`/`loadOne` 放进工作集。条件或排序在运行时拼出来的搜索与分页（`ordersPage`、`accountsPage`、`auditPage`、`movementViews`）和按集合写回（`records.SaveCollection`）仍手写。可空的列不要写 `::text` 之类的转换：sqlc 会把转换结果当成非空，读到 NULL 时出错。sqlc 读不了迁移里的 DO 块，表结构取 `internal/storage/schema.sql`（从跑完迁移的真库导出，`TestSchemaSnapshotMatchesMigrations` 守着）；改了迁移或查询后运行 `make backend-sqlc`（要库，同后端测试）重新导出并生成，`make backend-sqlc-check`（`make verify` 包含）核对生成的代码是最新的。

数据库保留账户/微信身份、认领用的密码（`account_passwords`：员工发的临时密码和以前顾客网页设的密码，只存 argon2id 哈希，不进数据导出）、登录会话（只存令牌的 SHA-256；`client` 区分小程序与员工网页后台 `web`，顾客网页留下的 `h5` 会话一律当无效）、扫码登录挑战（`web_logins`）、会员码（`member_codes`，同样只存令牌的 SHA-256，过期一小时以上的在签发时清掉）、限流计数（UNLOGGED 表 `rate_limit_windows`，重启丢了无所谓）、网页实时连接的报到（UNLOGGED 表 `web_presences`，见「API 使用要点」）、角色、布局/桌位/会话、座位预约、呼叫店员（`service_calls`）、商品库存、订单明细/付款退款、审计和幂等记录。审计与账务历史永久保留，只增不删；撤销任命、作废会话、清理过期幂等记录走专门的方法。幂等记录只用于保护客户端自己的重试，按应用时钟超过 30 天的键在写入新键时清除，不影响任何账务或审计历史。迁移在 `pindou-backend/internal/storage/migrations/`，启动时由 goose（`internal/storage/migrate.go`）在会话级咨询锁里按版本号执行，只向上，每个迁移与其登记在同一事务中；滚动更新时新旧版本会同时运行，所以迁移只做向后兼容的改动（先加后删）。新迁移按 goose 的写法以 `-- +goose Up` 开头，函数体这类含分号的语句用 `-- +goose StatementBegin`/`StatementEnd` 包住，不写 Down、不用 `NO TRANSACTION`；001–013 是 goose 之前写的、生产已执行过的，一个字节都不改，仍然整份文件一次执行（`TestMigrationFiles` 守着）。登记两份：goose 的 `goose_db_version`，以及旧执行器的 `schema_migrations`（0.0.8 及更早的程序只认它，退回时据此判断不重跑）；goose 每执行一个迁移也照旧记进 `schema_migrations`，第一次接手旧库时把那里已执行的登记过去。生产里 API 以库属主 `pindou` 连接，不是超级用户（CloudNativePG），迁移只能做属主做得了的事：建表、索引、触发器、函数，以及 `pgcrypto`、`pg_trgm` 这类 trusted 扩展；要超级用户的操作（非 trusted 扩展、改服务器参数）不能写进迁移，先在部署说明里另行处理。旧 `pindou_state`、`application_state`、`system_backups` 不再读写。已付款订单会被退款改写，所以 `Order` 及其明细、折扣、付款、退款不能新增总会出现的 JSON 键（`TestPaidOrderShapeIsFrozen`）；部分付款（partially_paid）的订单同样由触发器守着，只能追加付款、收齐变 paid（迁移 021），它的会话不能撤销。保存订单时先写明细、后改订单状态（`records.go` 的 Orders）：读草稿时计时明细按此刻重算，同一请求里收款，明细要趁库里还是草稿时写进去，否则明细触发器把它当成改已付订单的明细拒收。

生产数据不能重置或加载示例。退役的员工网页密码登录留下的 `login_name`、`password_hash`、`password_change_required` 列作为历史留在库里，程序不读不写，也不进数据导出。登录先写会话再发令牌，写库失败不发令牌；发布、重启不掉线。

会员规则与资产在 `internal/modules/membership/application` 处理整数计算、发布快照和积分批次；SQL 由现有 persistence repository 在同一事务保存，会员流水与发布记录受不可改写触发器保护。座位预约规则在 `internal/modules/reservations/domain`，只做时间窗口、歇业日、爽约统计窗口、占座和状态判定，不依赖 HTTP 或数据库；预约与预约设置由迁移 005 的 `reservations`、`reservation_settings` 保存，重启时按业务表重建（设置是一份 JSON，后加的项老数据里没有时按 `DefaultSettings` 补，不需要迁移）。过期、歇业、爽约暂停和现场会话占座都只按当前时间派生，不存在改写状态的后台任务。旧整桌会话座号为 0，新会话按座号保留历史；已获权益及交易以各自快照为准。

小程序只在本机保存会话凭证，不持久化订单和个人资料；主动退出时先请服务端作废这张令牌（`DELETE /auth/sessions/current`），再清除本机凭证。

开发者通过 `PINDOU_DEVELOPER_ACCOUNT_IDS` 配置账号 UUID 白名单，逗号分隔，留空关闭；非法配置在启动连接数据库前拒绝。切换接口更换 Bearer，原令牌立即失效，不延长有效期，不修改员工任命；数据库保存失败回滚会话与审计。开发者权限不落入业务数据，新登录的 `developer` 值表示尚未选择体验角色，不授予员工权限；接口保留该值兼容已有客户端，当前小程序选项仅有游客、顾客、店员、店长、老板。悬浮入口使用原生 MovableArea/MovableView，位置仅保存在运行内存，切换前复用离开保护并核对会话。前端切换成功清理页面栈，顾客请求通过版本丢弃旧响应，员工请求同时核对凭证与身份范围。响应丢失需重新登录，不能宣称已切换成功。

日志不得包含会话令牌、密码、微信凭证、完整手机号/微信标识或图片内容。使用 requestId 定位错误，账户列表和审计脱敏；全部数据导出含私密账户字段（完整手机号），仅老板可下载并留审计，不含登录凭证和幂等缓存。

## API 使用要点

基础路径 `/api/v2`，opaque Bearer 鉴权，不接受 Cookie。错误统一 `{ code, message, requestId }`。未登录的注册与微信登录接口按来源限流，超出返回 429 `rate_limited` 并带 `Retry-After`，被限流的请求不进入处理、不创建账户或会话、不消费微信凭证；来源取 Nginx 设置的 `X-Real-IP`/`X-Forwarded-For`，API 仅监听 loopback 时该来源可信。已登录的业务请求不受此预算影响；顾客自己就能反复点的写操作（呼叫店员）另按账户限流（`routes.go` 的 `accountLimited`，同样在事务之前，店里的顾客共用一个 Wi-Fi 出口，所以不按来源）。旧密码/扫码/开发老板登录路径返回 404，资料更新拒绝旧登录字段。

认领（`/auth/member-claims`，`internal/app/member_accounts.go`）按来源限流，另按手机号限流（`hitRate`，每 15 分钟 5 次、不论成败）。argon2id 的哈希与校验在事务外做（`identity/application/password.go`），事务里只核对校验时读到的哈希还是库里那一个；没有认领密码的号也陪跑一次校验。顾客网页的注册、手机号加密码登录、改密码三个接口 2026-10-31 去掉（回 404），库里剩下的 `h5` 会话在 `txn_auth.go` 一律当无效（`retiredClientH5`），不会被当成小程序会话、按真实任命给权限。迁移 022 之后退回 0.0.23 以前的版本前先删掉 `h5` 会话：那些版本不认识它，会按小程序会话给真实任命。

订单响应提供完整公开内容的 SHA-256 `version`，只用于并发确认，不是权限凭据，也不存入历史账务。明细/折扣/付款/退款请求携带 `expectedVersion` 和幂等键；缺失或格式错误为 400，过期为 409 `order_version_conflict`，失败不产生订单、库存、会话或审计变更。同键同内容先重放已成功结果，同键不同内容为 409 `idempotency_conflict`，重放前仍检查当前权限。订单写请求幂等作用域绑定操作者、操作、订单与请求键。

同会话已有草稿或部分付款的订单时建单返回现有订单，取消或结清后拒绝建单。计时怎么计价在 `internal/modules/tables/domain/charge.go`（纯函数，按已发布的套餐、续时方案与超时处理、自由计时价、陪客费查表分块，不按分钟折算）；订单的 `autoLines` 记开头几行是系统生成的计时明细：整桌会话改了计时（续时、改时长或计时方式、标记陪客）由 `tables.go` 的 `followDraft` 按新计时换掉并重算，时间流逝带来的块数变化由 `session_billing.go` 的 `followTime` 在每次读出草稿时按此刻重算（`q.order` 等订单读取都经过它；只读请求不落库），停止计时后按停止时刻；员工改过计时行记 0 不再改，没有这个字段的旧草稿照旧比对建单时刻的生成结果。撤销会话时草稿置为 voided。免单是付款记录里 method 为 comp 的结清记录，不计入 paidCents。分笔付款：收第一笔还没收齐时订单为 partially_paid（`ordersapp.Collect`、`OutstandingCents`），计时停在这一刻（`freezeSession`），`followTime` 只动草稿所以计价自然冻结；退款按笔（`ordersapp.RefundUnits`：会员结账那一笔是标了 `member` 的付款，一条没标的是一次收齐的旧单；退款的 `paymentId` 只在分几笔收的单上记，没记的按付款先后抵扣）。整桌会话的 PATCH 带了 `Idempotency-Key` 就按「操作者 + 会话 + 键」重放，续时（`extendMinutes` + `expectedDurationMinutes`）必须带。会话的结束时间只有 `sessionEndsAt` 一套算法（桌位视图的 endsAt、现场挡预约、续时和改时长核对后面的预约都用它），不另算。会话使用 `timed/free`，自由计时省略时长和结束时间；暂停通过 `pausedAt/pausedSeconds` 由后端排除暂停区间。订单状态为 draft/partially_paid/paid/refunded/voided（列表筛选另有 open＝draft 加 partially_paid），会话为 active/paused/companion/cancelled/settled。

头像使用可选 `avatarDataUrl`，不接收远程 URL、SVG 或临时路径。JPEG/PNG 输入最多 96 KiB、边长最多 512px、字符串最长 131100；后端检查实际格式并重编码 JPEG 去除元数据。省略保留、空串清除；注册非法头像不创建账户/会话或消费微信凭证，和账户一次成功或失败。客户端临时展示文件及时清理。

`GET /event-streams` 小程序使用 Bearer WebSocket（`github.com/coder/websocket`；只由服务端推送，每 30 秒发一次 Ping 心跳，客户端发来数据消息就断开），SSE 保留为诊断通道；员工收到全部资源事件，顾客只收到和自己账户有关的。连接/重连/事件到达后重新读取资源。事件走 PostgreSQL 的 LISTEN/NOTIFY：写事务里 `pg_notify('pindou_events', …)`，提交后才送达，回滚的写不会推送；「影响到哪些顾客」在写回记录时按写前写后的归属账户自动收集，不在各接口里登记。每个副本用一条专用连接监听，再推给自己的连接；监听断线重连后向所有人推一次 `resource:"*"`，让客户端整体重读，补上断线期间漏掉的事件。「手机当扫码枪」（`POST /scan-relays`，`internal/app/scanrelay.go`）走同一个频道，通知里带收件员工和码，各副本只推给这位员工网页会话的连接（`{"type":"scan.relayed","code":"…"}`），不推给别人和小程序，码不进任何表；网页员工连接连上时在 `web_presences` 报到、每次心跳续期、断开即删，转码时据此判断电脑在不在线（没有就 409 `computer_offline`）。不用 Redis：它的发布不跟事务走，提交失败也照样推出去，还多一个要部署、备份、监控的组件。

接口字段、路径与响应只在 YAML 维护，不再复制端点对齐表。改变接口时同步实现和相关客户端测试。

后端测试按契约核对每个接口响应（`internal/app/contract_test.go`，用支持 OpenAPI 3.1 的 libopenapi-validator）：测试经 `call`、`serve` 发出的每个 `/api/v2` 请求都核对。后端照办了的（成功的）请求本身也要合乎契约：查询参数、请求头、JSON 正文符合 schema，正文不能有契约没写的字段；所以测试编的请求要像真客户端（带正文时 `Content-Type: application/json`，没填的字段不发、不发空串——拿请求结构体编码的给字段加 `omitzero`）。后端的请求、响应结构体照旧手写、不从契约生成（oapi-codegen 还不支持 OpenAPI 3.1），由这两头的核对把它们和契约绑住。成功响应要求契约里有这个方法加路径和状态码，JSON 正文符合 schema（含 uuid、date-time 等 format），不能有契约没写的字段（`additionalProperties` 给了 schema 的按映射处理，只写 `type: object` 的不限内容），登记为 `required` 的响应头都在，契约没写响应内容的不能带正文；失败响应一律是只有 `code`、`message`、`requestId` 的 JSON，`requestId` 与 `X-Request-ID` 头一致，契约为这个状态在说明里写了错误码（小写下划线的词）时 `code` 要在其中（契约开头的全局错误码、400 时参数说明里写的 `idempotency_required` 也算）。不核对网页后台页面、不带 `/api/v2` 的探针别名和事件流，Excel 下载只核对状态码与类型。完整跑完 `internal/app` 时，契约里除事件流外每个接口都要有测试拿到过合乎契约的成功响应，否则测试失败。报出不符时先判断谁对：契约没写全真实行为就改 `docs/api.yaml`（3.1 写法，可空用 `type: [string, 'null']`，不用 `nullable`）并 `pnpm --dir pindou-admin api:types`、`npm --prefix pindou-miniapp run api:types`；后端前后不一致或违背和客户端的约定才改后端，并补测试。不为让测试通过放宽核对；测试直接写库造的夹具要像真实数据（会话带 `timingMode`，入座申请带套餐），否则响应不合契约。

## 网页后台约定

- **目录**：路由文件 `src/routes/_authed/<页面>.tsx` 只定义页面；可测的业务逻辑（金额换算、可否操作、表单规则）放 `src/features/<模块>/`，单元测试跟着放那里（放在 routes 下会被当成路由扫描）。接口函数放 `src/api/<模块>.ts`，用 `src/api/client.ts` 的 `client`（openapi-fetch）按契约调用，类型取自 `src/api/schema.d.ts`——它由 `pnpm api:types` 从 `docs/api.yaml` 生成并入库，`pnpm check` 发现它与契约不一致就失败。不手写接口类型；类型对不上时先按后端核对契约，契约错了改契约。新页面在 `src/nav.tsx` 登记侧栏和可见角色——只决定显示，权限以后端为准。
- **手机转来的码**：事件流里的 `scan.relayed` 交给 `src/realtime/scans.tsx`：页面或组件用 `useScanRelay(claim)` 认领（后挂上的先看，认得返回 true），都不认的在右下角提示「手机扫到」可复制。会员码（首位 9 的 20 位数字）用 `POST /member-codes/lookups` 查人；选顾客的 `CustomerPicker` 对扫码枪键入的会员码也按码查人，结尾的回车在外层捕获阶段拦下，免得 Semi 把高亮的候选当成选中。
- **读数据**：TanStack Query，queryKey 第一段用后端资源名（`['sales-orders', …]`）。实时事件到达时整体让查询过期，所以不用手动维护资源之间的牵连；标签页在后台时只标过期、切回再读，只有 `meta.realtimeInBackground` 的查询（呼叫店员的未处理列表，全站提醒用）在后台也随自己资源的事件立刻重读（`src/realtime/refresh.ts`）。页面用 `components/Page.tsx` 的 `Page` 与 `QueryState`（加载、无权限、失败重试、重读失败保留旧内容）。
- **列表**：会持续增长的列表（订单、审计、账号、会员）筛选、排序、分页都交给服务端，只取当前页（`pageSize`，总数读 `X-Total-Count` 响应头），否则每来一条实时事件都会重拉全部；选账号用服务端搜索的下拉（`GET /accounts?q=&pageSize=`）。商品、规则这类规模有限的列表可以整表取回再在前端筛。列表里的人名用接口带的称呼（订单 `customer`、审计 `actor`、任命 `account`、发布记录 `actor`），不为显示名字拉全部账号。
- **写数据**：`useMutation`，成功后 `queryClient.invalidateQueries()` 并 `Toast.success`；失败把后端的中文 `message` 原样显示。资金、库存、人工折扣等后端要求幂等键的写请求（契约里带 `Idempotency-Key` 参数，类型会要求）传 `params: { header: idempotencyKey() }`，真正用哪个键由 `api/client.ts` 的 `idempotentFetch` 决定：同一个动作（同一人、方法、地址，请求体里同一种 `action`、同一个 `targetId`/`accountId`/`stockItemId`/`serviceTableId`）上次没拿到明确结果（断网、5xx）时，内容一样就沿用上次的键；内容变了（重读后版本号、当前库存变了）先把上次那一条原样重发——成功就回 409 `previous_applied`（「上次已生效」）、不提交新的，4xx 再提交新的。只读的 `quote`、`preview_rule` 不参与。页面不用为此逐个处理，只是显示错误时用 `isPreviousApplied` 把这一条显示成提醒（warning），不当失败。**不做乐观更新**，金额、库存、状态只以接口返回为准；409 版本冲突时提示重读后再确认，不自动换版本重提。
- **表单**：TanStack Form + Zod 校验，输入控件用 Semi 的。不引 Semi 的 `Form`（它的静态属性挂着全部字段控件，引一个就把树选择、级联、上传等没用过的控件都打进包），表单项的标题、说明和错误要自己接到输入框上：`<label for>`、`aria-describedby`，出错时 `aria-invalid`，必填 `aria-required`——都用共用的字段外壳 `components/Field.tsx`（下拉框、多选组用它的 `labelledby`，单选组、日期选择器这类自己起不了名字的用 `radiogroup`/`group`，由外层这一组带标题）。Semi 的下拉框不收 `aria-label`，读屏名用 `components/NamedSelect.tsx`；同一页有几组单选时每组给自己的 `name`（Semi 不给时都叫 `default`，浏览器会把它们当成一组）。金额输入用 `lib/format.ts` 的 `parseYuan` 转整数分，不用 `parseFloat`；显示用 `money`。时间一律 `dateTime`/`dateOnly`（门店时区）。
- **确认**：删除、撤销、退款这类操作先确认，写清对象和后果，用 `components/confirm.ts` 的 `confirmDialog`（返回点没点确认，之后的请求由调用方发，不把会失败的 Promise 交给弹窗）。Semi 弹窗底部按钮写死英文 `aria-label`（confirm/cancel），它去掉了，读屏名就是按钮上的字；会丢掉输入、不能撤回的确认用 `okType: 'danger'`。自己写的 `<Modal>` 用默认底部按钮时展开它导出的 `dialogButtons`。
- **外观**：Semi 默认主题，样式只写布局；颜色需要时引用 `--semi-color-*`。
- **平面图**：「现场」看板的底图与座位热区只有一份，直接引用仓库根的 `layout/store-layout.json` 和小程序的 `src/assets/seatmap/plan.jpg`（`src/features/board/layout.ts`），不复制进 `pindou-admin`；开发服务器靠 `vite.config.ts` 的 `server.fs.allow` 放行这两处，构建时图片打包进 `assets/` 随页面嵌入后端。改这两处也要跑网页后台的检查（CI 已按路径带上）。
- **端到端**：`e2e/mock-api.ts` 的 `mockApi(page, { handlers })` 模拟接口、记录写请求（含幂等键），`signIn` 直接写入登录会话。下拉框选中后要等界面上依赖选中值的内容出现再继续（Semi Select 的回调稍晚）。

## 小程序读数据

- **读**：TanStack Query，`hooks/query.ts` 的 `useStaffQuery`（员工资源）、`useCustomerQuery`（顾客本人数据，`live: true` 时页面显示期间连实时事件，只给订单、订单详情、我的预约、本次手作、会员中心五页）、`usePublicQuery`（门店公开内容）。页面只写资源名和参数，身份段（登录状态、账户、体验身份、会话版本，员工另带角色）由 hook 加进查询键：身份一变旧内容立即不显示，迟到的响应只落到旧键上，其他身份的缓存随即删掉。
- **何时重读**：页面显示时读，不显示的页面（跳走、切 Tab、退到后台）查询停用、不定时刷新、不连实时事件，回来时立即重读；回到前台与网络恢复接在 Taro 的应用事件上（`services/query.ts` 的 `connectAppLifecycle`），不用 window/document 事件。员工页的 `useStaffEvents(间隔)` 返回 `refetchInterval` 交给本页查询；实时事件到达或重连时让显示中的查询整体重读，正在读的那次不打断，结束后补读一次。
- **写**：照旧调 services 里的请求函数（幂等键、不确定结果用同一个键重试都在那里：`services/staff.ts` 按「同一个动作」记下结果未知的原请求和原键，下次同一动作内容变了先原样重发它，已生效就抛 `previous_applied`，规则同网页后台的 `idempotentFetch`），成功后用 `useRefreshAll()` 或查询的 `refresh` 让查询重读。不做乐观更新，金额、库存、状态不存进本机。结账页的订单是表单初值（冲突后等人工重读），不进查询。
- **失败**：不自动重试，离线照样请求、照样提示；刷新失败保留上次内容，401/403/404 由 QueryCache 统一清掉内容。
- **分包里的共用代码**：Taro 的 vite 编译把被两个以上模块引用的源码一律放进主包的 `common.js`（node_modules 进 `vendors.js`），哪怕只有一个分包用。做图纸的模块、色卡数据和 culori 由 `config/maker-chunk.cjs` 拆进 `pages/maker/shared.js`，主包或别的分包引到它时构建失败；给做图纸加只在分包用的模块不用改配置，要给主包用的（底部「图纸」的入口）加进它的 `sharedWithMain`。分包几页用同一份样式时各页 `index.scss` 用 `@use` 引，并各加一条自己的规则：内容完全相同的样式文件打包时只留一份，其余页面就没有样式。上传前用 `npm run size` 看主包和各分包的体积。
- **转图算法**：改 `services/maker/` 里取色、挑色、去零星的代码，`npm test` 里的转图基准（`tests/maker-benchmark.test.ts`，20 张照片，打分规则见 `docs/plan-bead-maker.md` 第 6 节）不许变差；看前后的分数加 `--reporter=verbose`，有意取舍时 `UPDATE_BENCHMARK=1` 重写 `tests/fixtures/photos/baseline.json`，提交说明写清变了哪几项。测试照片只放公有领域或 CC0 的，来源和许可写进同目录的 `sources.json`。
- **运行环境**：小程序逻辑层没有 AbortController 等浏览器接口，依赖里用到的由构建时注入 `src/polyfills/runtime.ts`（`config/index.ts` 的 `mini.injectOptions`）。开发者工具跑在 Chromium 上看不出缺什么，新依赖要在真机上验。

## 小程序交互与视觉

- 顾客「预约座位」和员工「预约」使用 reservations 契约；小程序按门店营业时区（中国标准时间）生成和展示时段，不依赖设备时区，提交为带时区时间。
- 会员中心的会员码在小程序里自己画（`services/qr.ts`：版本 1、数字模式、纠错 Q，输出 1 位灰度 PNG 的 data URL 给 Image），不调微信接口、不引第三方库；`tests/qr.test.ts` 用独立的 jsQR 去扫画出来的图。页面显示期间每分钟换码（`hooks/member-code.ts`），离开页面就停。员工「扫会员码」与「手机当扫码枪」用 `Taro.scanCode`，只能真机验。
- 会员中心、顾客本次手作、员工「会员」页与桌位会话弹层统一使用 loyalty 契约；桌码 scene 为无连字符桌位 UUID，登录跳转须保留 tableId/scene。生成正式桌码要求微信配置和已发布入座页，本地复制码不代替正式微信验收。
- 游客首页与本地作品可直接浏览；当前 12 件生成灵感图分几何/花卉/生活小物三类，各 4 件，支持筛选预览，不能当作本店实拍、可售商品或已验证图纸。无门店实拍不展示相册。
- 默认首页，顾客原生 Tab 为首页/图纸/订单/我的（系统内收费关着时第三格写「我的预约」）；员工从“我的”进入员工端的「现场」。登录目标为内存中的一次性合法页面，取消/退出清除；恢复会话和资料刷新不跳页，迟到响应不得恢复已退出状态。
- 注册页与编辑资料页都给「获取微信手机号」按钮，没有开关。取消授权正常回手填，权限/隐私/网络失败显示固定提示与安全数字错误码（主体没有手机号快速验证能力时走的就是权限这一支，界面会说「请手动填写」并自动展开输入框）。注册头像可选，共用选择/压缩/预览控件，处理期间禁止提交。
- 返回优先真实上一页；无栈或失败时，资料编辑/现场回“我的”、代客登记回预约、结账回待结账、其他员工页回现场、我的预约与会员中心回“我的”、图纸详情回图纸、一张图纸和导入像素画回「我的图纸」、「我的图纸」和照片做图纸回图纸、其他顾客页回首页。应用内离开前确认未保存内容，提交期间阻止离开，业务成功返回无需再确认；不承诺拦截系统手势或进程关闭。
- 表单提供加载、空、失败、权限和提交中状态；刷新不清空现有内容，导航始终可见。网络刷新失败保留上次内容并明确提示，401/403/404 不保留受限资源。结账只有确认收款一个主操作（明细改过先保存），人工折扣在结账页先保存明细再按新版本减免；版本冲突后保留输入并等待人工重读。
- 现代手作风格：暖白画布、炭黑品牌区、哑金主按钮及深金色导航、Arco 图标；页面设计见 [DESIGN.md](../DESIGN.md)，共享 tokens 为尺寸/颜色来源。正文 16px、辅助说明 14px、分组标题 18px；页面边距 20px，窄屏 16px，作品图片圆角 12px，控件圆角 12px。顾客订单为平面列表，现场页突出「等你处理」和开台入口。自定义控件 48px 最小触控目标、48px 输入框、逻辑 px；公共 Button 使用 `.ui-button` 重置微信默认样式，不依赖 Taro 会改写的标签选择器。
- 窗口小于 768px 保持手机布局；768–1023px 员工内容上限 960px；1024px 起 192px 侧栏和桌位/结账/库存分栏，内容上限 1440px；顾客上限 640px。窗口变化不创建第二份表单、不丢输入或提交业务请求，离开时释放尺寸监听。
- 员工页面显示实时连接状态与最近成功读取时间，断线提供手动刷新；手机营业桌位默认网格并可切换平面图，电脑保留分栏。待结账按已返回数据分页浏览；查找顾客/会员（输入停顿 300ms 后查）和已结束的预约交给服务端筛选分页，不整表拉取账户或历史预约。折扣冲突保留输入，显式重读后再确认；固定金额和比例减免均由后端计算。订单退款、商品资料、盘点与库存流水、权限、报表与审计在网页后台，见上文「网页后台约定」；收货入库两边都有，小程序「收货入库」用 `Taro.scanCode` 扫商品条码（只能真机验），本页的商品目录在手机上按名称、条码过滤（目录规模有限，整表取回）。
- 桌位、会话与经营页前台每 5 秒重新读取资源（实时连接在线时放宽到 30 秒），后台停止、重新显示立即刷新，并保留 WebSocket；客户端不推演业务状态。时间一律按门店时区（中国标准时间）显示和输入（`services/format.ts` 的 `storeOffsetMinutes`），不跟手机时区走，和网页后台显示的时刻一致；提交为带时区时间。
- 顶栏都是自定义的（`navigationStyle: 'custom'`），状态栏的字（时间、电量）的颜色由 `navigationBarTextStyle` 定，微信默认白字，浅色顶栏上看不见：`app.config` 默认改成黑字，深色顶栏的页面给 `Screen` 传 `dark`，由它调 `setNavigationBarColor` 换成白字（登录和创建账号、调整照片和格数颜色、改图和边拼边看这种同一页里深浅会换的，跟着换）；一进来就是深色的首页、「我的」在页面配置里也写 `navigationBarTextStyle: 'white'`，免得先闪一下黑字。开在深色页里的白底弹框要写明字色，不写就继承深色页的浅色字，白底上看不见。
- 底部弹层一律套 `components/sheet.tsx` 的 `SheetFrame`（升起、滑下、拖着关，规则见 `docs/plan-interaction.md` 第 2 节），关闭按钮用 `SheetCloseButton` 才有滑下去的动画；页面组件测试里换成 `tests/helpers/sheet.ts` 的替身，把标题行和内容摊进面板。手势的计算（测速、阻尼、滑行）在 `services/gesture.ts`，都是纯函数，在单元测试里测；手感只能真机看。
- 画布（`<Canvas type="2d">`）在真机上是同层渲染，弹层、按钮都能盖在它上面；开发者工具里原生组件是用网页组件模拟的，画布总压在最上层。以真机为准，不要为了开发者工具的表现把画布藏起来（微信官方文档「原生组件」：除 focus 状态的 input 外都已支持同层渲染；做图纸曾因此在开弹层时把预览藏掉，业主在真机上看到预览突然消失）。
- Excel 通过文档打开/分享，JSON 写入用户目录后分享；失败应可见。没有 API 字段的金额汇总、地址、图表和订单封面不能用设计稿数据填充。

## 代码验证

只改文档无需运行验证。修改代码时按影响范围执行：

- 小程序目录 `npm run check`（含 tests/ 的类型）、`npm test`（Vitest）、`npm run build`；受影响真实微信流程在开发工具/真机验收。
- 根目录 `make backend-test`（自动准备测试库，见下文；同时按 `docs/api.yaml` 核对每个接口的请求与响应，见「API 使用要点」，改了接口没改契约会失败）、`make backend-lint` 与 `make backend-sqlc-check`；新迁移和数据库一致性改动增加对应流程的集成测试，改了迁移或 `internal/storage/queries/*.sql` 先 `make backend-sqlc`。
- 网页后台目录 `pnpm check`、`pnpm lint`、`pnpm format:check`、`pnpm test`（Vitest），根目录 `make admin-e2e`：构建并嵌入后用 `cmd/pindou-dev -fresh` 起真正的后端（测试库服务器上新建一个库、假微信，退出时删库），由 Playwright 在 Chromium 里验证生产 CSP 下的页面、扫码登录、实时连接与断线重连、会话失效回登录页，以及顾客域名的「请用微信扫码」那一页（`e2e/customer-host.spec.ts`）。首次运行先 `pnpm --dir pindou-admin exec playwright install chromium`。
- 前后端跨包运行根目录 `make verify`，保留后端测试/vet/lint、小程序类型检查/lint、服务测试和微信构建，以及网页后台的检查、单元测试和端到端。

后端测试一律连真实 PostgreSQL：`internal/testdb` 用 pgtestdb，同一组迁移只建一次模板库（按迁移内容的摘要命名），每个测试从模板复制出独立的库，测试通过后删除，失败的留着供排查；测试以专用角色 `pgtdbuser`（非超级用户）连库、跑迁移，从不碰连接串里写的那个库。数据库服务器：设了 `PINDOU_TEST_DATABASE_URL`（要能建角色和库，连维护库 postgres）就用它，CI 就是这样，模板跨次复用最快；没设时 `go test` 自己用 testcontainers 起一个与生产同一镜像的 PostgreSQL 容器（要 docker；每个测试包一个，进程退出后由 Ryuk 删掉），所以 `cd pindou-backend && go test ./...` 不用任何准备。`make backend-test`（`make verify` 包含）就是这样跑的；想更快就 `make test-db` 起常驻的 `pindou-test-pg`（端口 55432，跑完留着复用）并把该变量指向它。`make admin-e2e` 也用这个常驻容器。生产或共享库不能用作测试目标。

没设连接串又起不了容器时测试**失败**，不再静默跳过（2026-09-19 就吃过这个亏：持久层 SQL 从没在真库上跑过，`make verify` 照样全绿，上线后每次写请求都 503）。确实只改了前端或文档时用 `PINDOU_SKIP_DATABASE_TESTS=1 make verify` 显式跳过，此时后端几乎所有测试都不跑，交付时须如实说明。CI 启动独立 PostgreSQL 17 服务并配置该变量，之后用 `make backend-vuln`（govulncheck）扫描依赖漏洞。

测试辅助在 `internal/app/harness_test.go`：`newTestServer` 一个新库上的服务，`serverOn(t, db)` 在同一个库上再起一个（模拟重启或第二个副本），`edit`/`view` 在一个事务里直接改或读记录，`failWrites(t, s, 表)` 用触发器让某张表的写入失败。

微信 WXSS 检查：先构建小程序，将 `WECHAT_WXSS_COMPILER` 指向本机微信开发工具的 `node_modules/wcc/lib/wcsc.js`，在仓库根目录运行 `node pindou-miniapp/tests/wxss.cjs`。它直接调用微信编译器，补充 Taro 构建无法发现的选择器兼容问题，不代替真机流程验收。

保留权限/最后老板、版本与幂等并发、回滚/重启、不可变记录、旧数据兼容和退款库存等核心回归。浏览器测试只用于网页后台；小程序已有的静态样式、WXSS 与模拟平台测试不能代替真实微信验收，工具超时明确记为未验收。旧设计资料和历史浏览器脚本已移出仓库；运行素材与现用代码测试保留。
