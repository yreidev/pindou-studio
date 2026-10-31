package app

import "runtime/debug"

// Commit 由发布构建注入：-ldflags "-X github.com/yreidev/pindou-studio/pindou-backend/internal/app.Commit=<sha>"。
// 镜像构建时没有 .git，Go 自己记不下版本，所以必须注入。
var Commit string

// Version 是后端发布的版本号（标签 backend-v0.0.39 去掉 backend-v），由发布构建同样注入；本地构建没有，报告为 dev。
// 网页后台、小程序各有自己的版本号和标签（docs/plan-split-release.md），只发后端时它们不变。
var Version string

func buildVersion() string {
	if Version != "" {
		return Version
	}
	return "dev"
}

var runningVersion = buildVersion()

// buildCommit 是 /healthz 报告的版本：发布后用它核对线上跑的到底是哪个 commit。
// 没注入时退回 Go 自动记录的 git 信息（本地 go build）；工作区有未提交改动就带 -dirty，
// 一眼看出这不是能追溯到某个 commit 的产物。
func buildCommit() string {
	if Commit != "" {
		return Commit
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	revision, dirty := "", false
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			revision = setting.Value
		case "vcs.modified":
			dirty = setting.Value == "true"
		}
	}
	if revision == "" {
		return "unknown"
	}
	if dirty {
		return revision + "-dirty"
	}
	return revision
}

var runningCommit = buildCommit()
