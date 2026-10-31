# 后端镜像只装一个二进制：先用 make backend-binary 按 go.mod 的 toolchain 行编译
# （CI 与测试同一工具链，这里不再出现第二个 Go 版本号），构建上下文是 pindou-backend/bin。
#
# distroless static：自带 CA 证书（调微信接口要用）、非 root 用户 65532，没有 shell。
# 不需要时区数据：门店时区在代码里写死为东八区。迁移和门店布局都编译进了二进制，不读写任何文件，
# 所以可以只读根文件系统运行。
FROM gcr.io/distroless/static-debian13:nonroot
COPY pindou-api /pindou-api
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/pindou-api"]
