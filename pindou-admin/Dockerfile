# 网页后台镜像只装一个二进制：make admin-binary 先构建页面、编进 cmd/pindou-admin-web，再按 go.mod 的 toolchain 行
# 编译，构建上下文是 pindou-admin/bin（docs/plan-split-release.md）。
#
# distroless static：非 root 用户 65532，没有 shell。页面编进了二进制，不读写任何文件，可以只读根文件系统运行；
# 不连数据库，也不调外部接口。接口由后端镜像提供，Traefik 把同一域名的 /api/ 转过去。
FROM gcr.io/distroless/static-debian13:nonroot
COPY pindou-admin-web /pindou-admin-web
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/pindou-admin-web"]
