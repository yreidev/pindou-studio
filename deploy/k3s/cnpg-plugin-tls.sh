#!/usr/bin/env bash
# 生成 CloudNativePG 运算符与 Barman Cloud 插件之间的 mTLS 证书，存成 cnpg-system 里的两个 TLS Secret。
# 官方用 cert-manager 签；这里不装 cert-manager，用两张自签证书（10 年）代替，效果相同：
#   barman-cloud-server-tls  插件的服务端证书（DNS 名 barman-cloud，运算符拿它的 tls.crt 当信任根）
#   barman-cloud-client-tls  运算符的客户端证书（插件用 --client-cert 指向它的 tls.crt 校验运算符）
# 用法：deploy/k3s/cnpg-plugin-tls.sh          已存在就什么都不做
#       deploy/k3s/cnpg-plugin-tls.sh --rotate 重新生成并重启两边（到期前、或怀疑泄露时）
# 私钥只在临时目录里存在片刻，不打印、不落盘。
set -euo pipefail
ns=cnpg-system
rotate=${1:-}
if [ "$rotate" != --rotate ] && kubectl -n "$ns" get secret barman-cloud-server-tls barman-cloud-client-tls >/dev/null 2>&1; then
  echo "两个证书 Secret 都已存在，跳过（要换证书加 --rotate）"
  exit 0
fi
umask 077
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
make_cert() { # 名字 CN 扩展用途 [SAN]
  local extra=()
  [ -n "${4:-}" ] && extra=(-addext "subjectAltName=$4")
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -subj "/CN=$2" -keyout "$dir/$1.key" -out "$dir/$1.crt" \
    -addext "basicConstraints=critical,CA:FALSE" -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=$3" "${extra[@]}" 2>/dev/null
}
make_cert server barman-cloud serverAuth DNS:barman-cloud
make_cert client barman-cloud-client clientAuth
kubectl get namespace "$ns" >/dev/null 2>&1 || kubectl create namespace "$ns"
for side in server client; do
  # ca.crt 与 cert-manager 生成的 Secret 保持同样的键；自签证书的签发者就是它自己
  kubectl -n "$ns" create secret generic "barman-cloud-$side-tls" --type=kubernetes.io/tls \
    --from-file=tls.crt="$dir/$side.crt" --from-file=tls.key="$dir/$side.key" --from-file=ca.crt="$dir/$side.crt" \
    --dry-run=client -o yaml | kubectl apply -f -
done
if [ "$rotate" = --rotate ]; then
  kubectl -n "$ns" rollout restart deploy/barman-cloud deploy/cnpg-controller-manager
fi
echo "证书有效期至 $(openssl x509 -noout -enddate -in "$dir/server.crt" | cut -d= -f2)"
