.DEFAULT_GOAL := help
.PHONY: store-config-test help backend-tools backend-tools-versions backend-test-db backend-vuln backend-binary backend-image admin-dev admin-check admin-format admin-lint admin-test admin-build admin-embed admin-binary admin-image admin-e2e frontend-dev frontend-check frontend-format frontend-lint frontend-test frontend-build miniapp-preview miniapp-upload backend-dev dev-db dev-db-reset test-db backend-test backend-check backend-lint backend-sqlc backend-sqlc-check lint test verify node-version

# Go 编译缓存与临时目录：环境变量里有就用它（CI 的缓存设成 setup-go 会缓存的位置），本地默认放在家目录。
# 不放 /tmp：/tmp 常是内存盘，几 GB 的编译缓存加上 go test 的临时二进制会把它写满，后台任务的输出随之丢失。
GOCACHE ?= $(HOME)/.cache/pindou-go-build
GOTMPDIR ?= $(HOME)/.cache/pindou-go-tmp
export GOCACHE GOTMPDIR
$(shell mkdir -p "$(GOCACHE)" "$(GOTMPDIR)")

# Node 只由 .nvmrc 指定、具体到补丁版本，CI 的 setup-node 读同一个文件。本机装了 nvm 且有这一版时，make 里的命令优先用它，
# 不改本机默认的 Node（默认版本下装着别的全局工具）。2026-10-06 本机 24.18、CI 24.21，网页一个测试只在 CI 上挂。
NODE_VERSION := $(shell cat .nvmrc)
NVM_NODE_BIN := $(HOME)/.nvm/versions/node/v$(NODE_VERSION)/bin
ifneq ($(wildcard $(NVM_NODE_BIN)/node),)
export PATH := $(NVM_NODE_BIN):$(PATH)
endif

help:
	@printf '%s\n' \
	  '本地开发（持续运行，Ctrl+C 停止）：' \
	  '  make frontend-dev       微信小程序持续构建' \
	  '  make backend-dev        启动 Go API（本机 PostgreSQL 容器、假微信），默认 127.0.0.1:8080' \
	  '  make admin-dev          网页后台开发服务器（接口代理到 backend-dev）' \
	  '' \
	  '测试与构建：' \
	  '  make test               运行前后端测试，不构建' \
	  '  make backend-test       运行 Go 测试（连 PINDOU_TEST_DATABASE_URL，没设时 go test 用 testcontainers 自己起库）' \
	  '  make backend-check      Go 测试和 vet' \
	  '  make backend-lint       golangci-lint 静态检查' \
	  '  make backend-sqlc       迁移或 internal/storage/queries/*.sql 改了之后重新生成 sqlc 代码（要库）' \
	  '  make backend-sqlc-check sqlc 生成的代码是否最新' \
	  '  make backend-vuln       govulncheck 依赖漏洞扫描' \
	  '' \
	  '发布（三端各自发版，见 docs/plan-split-release.md）：' \
	  '  make backend-binary     按 go.mod 的 toolchain 编译后端 linux/amd64 二进制（只有接口），写入版本和 commit' \
	  '  make backend-image      在二进制之上构建后端镜像（BACKEND_IMAGE、BACKEND_TAG 可覆盖）' \
	  '  make admin-binary       构建网页后台页面并编进页面服务（cmd/pindou-admin-web），版本取 pindou-admin/package.json' \
	  '  make admin-image        在它之上构建网页后台镜像（ADMIN_IMAGE、ADMIN_TAG 可覆盖）' \
	  '  make frontend-test      仅运行小程序单元测试（Vitest）' \
	  '  make frontend-check     TypeScript 类型检查' \
	  '  make frontend-format    Prettier 格式检查' \
	  '  make frontend-lint      小程序 ESLint 检查' \
	  '  make frontend-build     微信小程序构建' \
	  '  make miniapp-preview    构建后用 miniprogram-ci 预览（要 WECHAT_MP_UPLOAD_KEY=密钥文件路径）' \
	  '  make miniapp-upload     构建后用 miniprogram-ci 上传体验版，版本取 package.json（DESC=说明）' \
	  '  make admin-check        网页后台类型检查（admin-format/admin-lint/admin-test 同理）' \
	  '  make admin-build        网页后台构建；admin-embed 再复制进 internal/adminui 供 go:embed' \
	  '  make admin-e2e          构建、嵌入，起连临时库的开发后端（接口和网页后台同一端口）跑 Playwright 端到端' \
	  '  make lint               前后端静态检查' \
	  '  make verify             后端测试/vet/lint、小程序与网页后台的检查/测试/构建、网页端到端' \
	  '' \
	  '后端测试与端到端都要 PostgreSQL：没设 PINDOU_TEST_DATABASE_URL 时自动起本机容器（要 docker）；' \
	  '确实无关时用 PINDOU_SKIP_DATABASE_TESTS=1 显式跳过。文档修改无需验证。'

frontend-dev:
	npm run dev --prefix pindou-miniapp

# 网页后台（pindou-admin）用 pnpm；依赖先在 pindou-admin 下 pnpm install --frozen-lockfile。
admin-dev:
	pnpm --dir pindou-admin dev

admin-check:
	pnpm --dir pindou-admin check

admin-format:
	pnpm --dir pindou-admin format:check

admin-lint:
	pnpm --dir pindou-admin lint

admin-test:
	pnpm --dir pindou-admin test

admin-build:
	pnpm --dir pindou-admin build

# 产物复制进 pindou-backend/internal/adminui/dist，由 go:embed 编进网页后台服务（生产）和 cmd/pindou-dev（本机、端到端）。
admin-embed: admin-build
	pnpm --dir pindou-admin embed

# 端到端跑在真正的 Go 后端上（cmd/pindou-dev：每次一个新建的库、假微信，同一端口提供接口和网页后台页面，
# 见 pindou-admin/playwright.config.ts）。顾客域名的「请用微信扫码」页也在这里测（e2e/customer-host.spec.ts）。
# 没设 PINDOU_TEST_DATABASE_URL 时用本机的测试库容器。首次需要 pnpm --dir pindou-admin exec playwright install chromium。
# E2E_ARGS 原样交给 playwright test，CI 用它分片（E2E_ARGS=--shard=1/3），本机也可以只跑一个文件。
E2E_ARGS ?=
admin-e2e:
	@if [ -z "$$PINDOU_TEST_DATABASE_URL" ] && [ -z "$$PINDOU_DEV_DATABASE_URL" ]; then $(MAKE) --no-print-directory test-db; fi
	PINDOU_TEST_DATABASE_URL="$${PINDOU_TEST_DATABASE_URL:-$(TEST_DATABASE_URL)}" pnpm --dir pindou-admin e2e $(E2E_ARGS)

# 本机开发：API 只跑在 PostgreSQL 上。没设 PINDOU_DEV_DATABASE_URL 时起一个本机容器（数据留在容器里，
# make dev-db-reset 清空），库名 pindou_dev，微信是假的（登录码直接当身份）。
DEV_DATABASE_URL ?= postgres://postgres:pindou-dev@127.0.0.1:55431/postgres?sslmode=disable
backend-dev:
	@if [ -z "$$PINDOU_DEV_DATABASE_URL" ]; then $(MAKE) --no-print-directory dev-db; fi
	cd pindou-backend && PINDOU_DEV_DATABASE_URL="$${PINDOU_DEV_DATABASE_URL:-$(DEV_DATABASE_URL)}" PINDOU_HTTP_ADDRESS="$${PINDOU_HTTP_ADDRESS:-127.0.0.1:8080}" go run ./cmd/pindou-dev -db pindou_dev

dev-db:
	@docker inspect -f '{{.State.Running}}' pindou-dev-pg 2>/dev/null | grep -q true || { \
	  docker rm -f pindou-dev-pg >/dev/null 2>&1; \
	  docker run -d --name pindou-dev-pg -e POSTGRES_PASSWORD=pindou-dev -p 55431:5432 postgres:17.11-trixie >/dev/null; }
	@for i in $$(seq 1 30); do docker exec pindou-dev-pg pg_isready -U postgres >/dev/null 2>&1 && exit 0; sleep 1; done; echo '开发库容器没有就绪' >&2; exit 1

dev-db-reset:
	docker rm -f pindou-dev-pg

frontend-check:
	npm run check --prefix pindou-miniapp

frontend-format:
	npm run format:check --prefix pindou-miniapp

frontend-lint:
	npm run lint --prefix pindou-miniapp

frontend-build:
	npm run build --prefix pindou-miniapp

# 小程序预览、上传：微信官方 miniprogram-ci（deploy/miniprogram），不开开发者工具，也没有它的分包缓存问题。
# WECHAT_MP_UPLOAD_KEY 是代码上传密钥文件的路径（公众平台 → 开发管理 → 开发设置），密钥不进仓库。
miniapp-preview: frontend-build
	npm ci --prefix deploy/miniprogram --no-audit --no-fund
	node deploy/miniprogram/mp.mjs preview "$${DESC:-}"

miniapp-upload: frontend-build
	npm ci --prefix deploy/miniprogram --no-audit --no-fund
	node deploy/miniprogram/mp.mjs upload "$${DESC:-}"

frontend-test:
	npm test --prefix pindou-miniapp

# 后端测试一律连真实 PostgreSQL（pgtestdb：每个测试一个从迁移好的模板复制的临时库）。设了
# PINDOU_TEST_DATABASE_URL 就连它；没设时 go test 自己用 testcontainers 起容器（要 docker，每个测试包一个，
# 跑完自动删掉），不用先准备。想更快就先 make test-db，再 export PINDOU_TEST_DATABASE_URL=$(TEST_DATABASE_URL)：
# 模板库跨次复用。
#
# ★★ 2026-09-19 的教训：那时没设连接串数据库测试会静默跳过，改了持久层 SQL 却从没在真库上跑过，
#    make verify 照样全绿，上线后每次写请求都 503。现在没有库就失败；确实不需要时用
#    PINDOU_SKIP_DATABASE_TESTS=1 显式跳过（交付时如实说明）。
TEST_DATABASE_URL ?= postgres://postgres:pindou-test@127.0.0.1:55432/postgres?sslmode=disable
backend-test:
	@if [ -n "$$PINDOU_SKIP_DATABASE_TESTS" ] && [ -z "$$PINDOU_TEST_DATABASE_URL" ]; then \
	  printf '%s\n' '' '!! 已显式跳过数据库测试：后端几乎所有测试都要连库，交付时须如实说明。' ''; \
	fi
	cd pindou-backend && go test ./... -count=1

# 旧名字，等同 backend-test。
backend-test-db: backend-test

# 常驻的本机测试库容器（与生产同一镜像，留着复用）：网页端到端用它；后端测试设了 PINDOU_TEST_DATABASE_URL 也能用它。
test-db:
	@docker inspect -f '{{.State.Running}}' pindou-test-pg 2>/dev/null | grep -q true || { \
	  docker rm -f pindou-test-pg >/dev/null 2>&1; \
	  docker run -d --name pindou-test-pg -e POSTGRES_PASSWORD=pindou-test -p 55432:5432 postgres:17.11-trixie >/dev/null; }
	@for i in $$(seq 1 30); do docker exec pindou-test-pg pg_isready -U postgres >/dev/null 2>&1 && exit 0; sleep 1; done; echo '测试库容器没有就绪' >&2; exit 1

backend-check: backend-test
	cd pindou-backend && go vet ./...

# 后端检查用的三个工具，版本只写在这里（CI 按这几个版本加 Go 版本缓存编好的程序，见 verify.yml）。
# golangci-lint 固定使用 go.mod toolchain 行声明的工具链：分析器读不了比它自身更新的 Go 导出数据格式，
# 所以它本身要用不旧于这一版的 Go 编译——用 go install 从源码编，不下载官方预编译的程序。
GOLANGCI_LINT_VERSION := v2.14.0
GOVULNCHECK_VERSION := v1.8.0
SQLC_VERSION := v1.31.1

# 装好这三个工具（go install 到 GOBIN；sqlc 要 cgo，需要 gcc）。
backend-tools:
	go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION)
	go install golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION)
	env -u GOCACHE go install github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION)

# CI 的工具缓存键：版本一变就重新编。
backend-tools-versions:
	@echo golangci-lint-$(GOLANGCI_LINT_VERSION)_govulncheck-$(GOVULNCHECK_VERSION)_sqlc-$(SQLC_VERSION)

backend-lint:
	@command -v golangci-lint >/dev/null || { echo '未找到 golangci-lint，请先 make backend-tools'; exit 1; }
	cd pindou-backend && GOTOOLCHAIN=$$(sed -n 's/^toolchain //p' go.mod) golangci-lint run ./...

# 固定写法的 SQL 在 internal/storage/queries/*.sql，由 sqlc 生成 Go 代码（提交进仓库，见 pindou-backend/sqlc.yaml）。
# PATH 里有版本正好是 SQLC_VERSION 的 sqlc（make backend-tools 装的、CI 缓存的）就直接用；
# 没有或版本不对，就 go run 这个版本（sqlc 用 PostgreSQL 自己的解析器，要 cgo，编一次要一两分钟；
# 它的构建缓存很大：去掉上面导出的 GOCACHE，用 Go 默认的位置）。
SQLC ?= $(if $(filter $(SQLC_VERSION),$(shell sqlc version 2>/dev/null)),sqlc,env -u GOCACHE go run github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION))

# 先从跑完迁移的真库重新导出 schema.sql（sqlc 读不了迁移里的 DO 块；要库，同 backend-test），再生成代码。
backend-sqlc:
	cd pindou-backend && PINDOU_UPDATE_SCHEMA=1 go test ./internal/storage -run '^TestSchemaSnapshotMatchesMigrations$$' -count=1
	cd pindou-backend && $(SQLC) generate

# 生成的代码与查询、schema.sql 一致；schema.sql 与迁移一致由 backend-test 里的 TestSchemaSnapshotMatchesMigrations 核对。
backend-sqlc-check:
	cd pindou-backend && $(SQLC) diff

backend-vuln:
	@command -v govulncheck >/dev/null || { echo '未找到 govulncheck，请先 make backend-tools'; exit 1; }
	cd pindou-backend && GOTOOLCHAIN=$$(sed -n 's/^toolchain //p' go.mod) govulncheck ./...

# 发布产物只来自能追溯的 commit：二进制里写入 commit，/healthz 原样报告。
# 工作区有未提交改动时带 -dirty，一眼看出这不是能对应到某个 commit 的产物（CI 里显式传 BACKEND_COMMIT）。
BACKEND_COMMIT ?= $(shell git rev-parse HEAD)$(shell git status --porcelain | grep -q . && echo -dirty)
# 版本号：发布时由 CI 按标签传入（backend-v0.0.39 → 0.0.39）；本地构建不传，/healthz 报告 dev。
BACKEND_VERSION ?= dev
BACKEND_IMAGE ?= docker.io/yreidev/pindou-api
BACKEND_TAG ?= sha-$(shell git rev-parse --short=7 HEAD)$(shell git status --porcelain | grep -q . && echo -dirty)

# 后端二进制只有接口，不嵌页面：网页后台单独一个镜像（下面的 admin-binary），顾客网页已下线（docs/plan-split-release.md）。
backend-binary:
	cd pindou-backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=$$(sed -n 's/^toolchain //p' go.mod) \
	  go build -trimpath -ldflags "-s -w -X github.com/yreidev/pindou-studio/pindou-backend/internal/app.Commit=$(BACKEND_COMMIT) -X github.com/yreidev/pindou-studio/pindou-backend/internal/app.Version=$(BACKEND_VERSION)" -o bin/pindou-api ./cmd/pindou-api

backend-image: backend-binary
	docker build -f pindou-backend/Dockerfile -t $(BACKEND_IMAGE):$(BACKEND_TAG) pindou-backend/bin

# 网页后台镜像：页面编进只提供页面的 Go 小程序 cmd/pindou-admin-web（复用 internal/webui 的托管方式，不连库）。
# 版本取 pindou-admin/package.json（打 admin-v 标签时 CI 核对两者一致），首页显示它和构建的 commit；commit 写法同后端。
ADMIN_VERSION ?= $(shell node -p "require('./pindou-admin/package.json').version")
ADMIN_COMMIT ?= $(BACKEND_COMMIT)
ADMIN_IMAGE ?= docker.io/yreidev/pindou-admin
ADMIN_TAG ?= $(BACKEND_TAG)

# 页面构建时读 PINDOU_ADMIN_COMMIT（pindou-admin/vite.config.ts）：这里导出给先决条件 admin-embed 里的构建用。
admin-binary: export PINDOU_ADMIN_COMMIT := $(ADMIN_COMMIT)
admin-binary: admin-embed
	cd pindou-backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=$$(sed -n 's/^toolchain //p' go.mod) \
	  go build -trimpath -ldflags "-s -w -X main.Commit=$(ADMIN_COMMIT) -X main.Version=$(ADMIN_VERSION)" -o ../pindou-admin/bin/pindou-admin-web ./cmd/pindou-admin-web

admin-image: admin-binary
	docker build -f pindou-admin/Dockerfile -t $(ADMIN_IMAGE):$(ADMIN_TAG) pindou-admin/bin

lint:
	$(MAKE) backend-lint
	$(MAKE) frontend-lint
	$(MAKE) admin-lint

test:
	$(MAKE) backend-test
	$(MAKE) frontend-test
	$(MAKE) admin-test

# 发布前的闸门先核对 Node：版本不对时前端检查和 CI 的结果可能不一样。
node-version:
	@test "$$(node --version)" = "v$(NODE_VERSION)" || { echo "本机 Node 是 $$(node --version)，.nvmrc 要求 v$(NODE_VERSION)：先 nvm install $(NODE_VERSION)（make 会自动用它）"; exit 1; }

store-config-test:
	python3 -m unittest discover -s deploy -p test_apply_store_config.py

verify:
	$(MAKE) store-config-test
	$(MAKE) node-version
	$(MAKE) backend-check
	$(MAKE) backend-lint
	$(MAKE) backend-sqlc-check
	$(MAKE) frontend-check
	$(MAKE) frontend-format
	$(MAKE) frontend-lint
	$(MAKE) frontend-test
	$(MAKE) frontend-build
	$(MAKE) admin-check
	$(MAKE) admin-format
	$(MAKE) admin-lint
	$(MAKE) admin-test
	$(MAKE) admin-e2e
