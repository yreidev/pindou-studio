#!/bin/sh
# 在 k3s 节点上预拉 CloudNativePG 的镜像（deploy/k3s/cnpg-images.txt）。在服务器上以 root 运行：
#   sh cnpg-prepull.sh cnpg-images.txt
# 国内服务器的加速（mirror.ccs.tencentyun.com）只代理 Docker Hub，ghcr.io 直连时好时坏。所以按 digest 依次试
# ghcr.io 和国内的公共镜像站，拉到后打成清单里写的 ghcr.io 名字；清单都是 IfNotPresent，之后不再联网拉。
# digest 固定了内容，镜像站给不出同一个 digest 就拉不下来，不会拉到被换过的镜像。
# 默认先走国内镜像站：2026-10-05 生产服务器上 ghcr.io 的接口 0.6 秒就回，但镜像数据走 GitHub 的境外下载节点，
# 被限速到 38MB 拉了近 10 分钟；南京大学镜像站 0.05 秒回应，彩排时四个镜像 40 秒拉完。
# 可用环境变量换镜像站顺序（空格分隔）：CNPG_REGISTRIES="ghcr.io ghcr.nju.edu.cn"
set -eu
list=${1:-$(dirname "$0")/cnpg-images.txt}
registries=${CNPG_REGISTRIES:-ghcr.nju.edu.cn ghcr.m.daocloud.io ghcr.io}
# 服务器上是 k3s 的子命令；在 k3s 容器里（本机彩排）直接有 crictl/ctr
if k3s crictl --version >/dev/null 2>&1; then crictl="k3s crictl"; ctr="k3s ctr"; else crictl=crictl; ctr=ctr; fi
digests() { $crictl inspecti -o go-template --template '{{range .status.repoDigests}}{{.}} {{end}}' "$1" 2>/dev/null || true; }
grep -v '^#' "$list" | grep -v '^[[:space:]]*$' | while read -r name digest amd64; do
  repo=${name#ghcr.io/}
  repo=${repo%:*}
  # 已有：按索引 digest 拉的，或离线导入的单平台镜像（amd64 清单的 digest）
  if digests "$name" | grep -q -e "$digest" -e "${amd64:-$digest}"; then
    echo "已有 $name"
    continue
  fi
  ok=
  for reg in $registries; do
    src="$reg/$repo@$digest"
    echo "拉取 $src"
    if timeout 600 $crictl pull "$src" >/dev/null 2>&1; then
      $ctr -n k8s.io images tag --force "$src" "$name" >/dev/null
      ok=1
      break
    fi
    echo "  $reg 拉不到，换下一个"
  done
  if [ -z "$ok" ]; then echo "!! $name 所有来源都拉不到" >&2; exit 1; fi
  # 核对：清单里的名字指向的就是这个 digest。刚打完标签立刻读，大镜像有时还读不到（2026-10-05 拉 PostgreSQL 时遇到），稍等重读
  tries=0
  until digests "$name" | grep -q "$digest"; do
    tries=$((tries + 1))
    if [ "$tries" -ge 5 ]; then echo "!! $name 的 digest 对不上" >&2; exit 1; fi
    sleep 2
  done
  echo "就绪 $name"
done
echo "全部就绪"
