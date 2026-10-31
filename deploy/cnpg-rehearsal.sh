#!/usr/bin/env bash
# CloudNativePG 的本机彩排：在 Docker 里起一次性的 k3s（与生产同版本），用生产同样的清单从零建库、起 API，
# 再按 docs/deployment.md「按时间点恢复」的命令走一遍，计停机时间、核对数据。升级运算符或 PostgreSQL、接 COS 之前先跑这个。
# 不碰生产：kubectl 用的是从 k3s 镜像里取出的二进制和这里生成的 kubeconfig，每个阶段开头核对节点名。
#
# 用法（仓库根目录）：
#   deploy/cnpg-rehearsal.sh all                    从头到尾：up prepare db app pitr
#   deploy/cnpg-rehearsal.sh pitr                   只跑某几个阶段（按顺序，前面的阶段要跑过）
#   CNPG_REHEARSAL_DUMP=<pg_dump 归档> deploy/cnpg-rehearsal.sh all
#                                                   用一份生产备份代替造的数据，最接近真实情况（数据只留在本机容器里）
#   deploy/cnpg-rehearsal.sh down                   删掉容器、数据卷和工作目录
# 需要 docker、curl、jq、openssl。工作目录默认 ~/.cache/pindou-cnpg-rehearsal（不放 /tmp：k3s 的数据卷在 Docker 里，
# 这里只有 kubeconfig、日志和几份 dump）。
#
# 阶段：
#   up        起 k3s v1.36.4；容器里 ghcr.io 解析到 127.0.0.1，模拟国内服务器直连不了 ghcr.io
#   prepare   预拉镜像（按 digest 经国内镜像站）、插件证书、运算符与插件、Secret
#   db        pindou-db.yaml 从零建库；核对连续归档、立即基础备份
#   app       pindou.yaml 起 API（假微信），经 Traefik 造数据或导入生产备份；跑一次 pg_dump 备份任务
#   pitr      已知时刻的写入 → 恢复到两次写入之间的新集群 → 核对哪些行在 → 整库回到那一刻
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NAME=pindou-cnpg-rehearsal
VOLUME=$NAME-k3s
K3S_IMAGE=docker.io/rancher/k3s:v1.36.4-k3s1
DIR=${CNPG_REHEARSAL_DIR:-$HOME/.cache/pindou-cnpg-rehearsal}
HOST=pindou.example.invalid
RUN=$(date +%H%M%S) # 这次运行的写入都带上它：单跑某个阶段重来时不会撞上已注册的登录码
mkdir -p "$DIR/bin"
export KUBECONFIG=$DIR/kubeconfig
export PATH=$DIR/bin:$PATH

log() { printf '\n== %s %s\n' "$(date +%T)" "$*"; }
ms() { date +%s%3N; }
since() { echo "$(( ($(ms) - $1) / 100 ))" | sed -E 's/([0-9])$/.\1/;s/^\./0./'; } # 秒，一位小数
k() { kubectl -n pindou "$@"; }
node_ip() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME"; }
guard() {
  [ "$(kubectl get nodes -o jsonpath='{.items[*].metadata.name}' 2>/dev/null)" = "$NAME" ] \
    || { echo "当前 kubeconfig 不是彩排集群 $NAME，停止" >&2; exit 1; }
}
api() { # 方法 路径 [JSON] [令牌]：经 Traefik 调 API，打印响应体
  local ip; ip=$(node_ip)
  curl -sS -fk --max-time 20 --resolve "$HOST:443:$ip" -X "$1" "https://$HOST$2" -H 'Content-Type: application/json' \
    -H "X-Real-IP: 10.9.$((RANDOM % 250)).$((RANDOM % 250 + 1))" -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" \
    ${4:+-H "Authorization: Bearer $4"} ${3:+-d "$3"}
}
register() { api POST /api/v2/accounts "{\"wechatLoginCode\":\"$1\",\"nickname\":\"$2\",\"phone\":\"$3\",\"privacyContractVersion\":\"2026-10\"}" | jq -r .user.id; }
login() { api POST /api/v2/auth/wechat-sessions "{\"wechatLoginCode\":\"$1\"}" | jq -r .accessToken; }
paid_order() { # 令牌 顾客 金额（分） 明细名：草稿 → 明细 → 现金付款
  local order version id
  order=$(api POST /api/v2/sales-orders "{\"accountId\":\"$2\"}" "$1")
  id=$(jq -r .id <<<"$order"); version=$(jq -r .version <<<"$order")
  version=$(api PATCH "/api/v2/sales-orders/$id" "{\"expectedVersion\":\"$version\",\"lines\":[{\"name\":\"$4\",\"quantity\":1,\"unitPriceCents\":$3}]}" "$1" | jq -r .version)
  api POST "/api/v2/sales-orders/$id/payments" "{\"expectedVersion\":\"$version\",\"method\":\"cash\",\"amountCents\":$3}" "$1" | jq -r '"订单 " + .id + " " + .status'
}
# 一笔写入：注册顾客（公开接口）；造数据时建的老板能登录时再给他开一张已付款订单。
# 用生产备份彩排时没有能登录的老板，只注册。
write() { # 登录码 昵称 手机号 金额（分） 明细名
  local c token
  c=$(register "$1-$RUN" "$2" "$3")
  token=$(login rehearsal-owner 2>/dev/null || true)
  if [ -n "$token" ] && [ "$token" != null ]; then paid_order "$token" "$c" "$4" "$5"; else echo "顾客 $c（$2）"; fi
}
# 经 API 读 PITR 开头的顾客（员工接口，走的是 postgres 服务此刻指向的库）
pitr_accounts() {
  local token; token=$(login rehearsal-owner 2>/dev/null || true)
  if [ -n "$token" ] && [ "$token" != null ]; then
    api GET '/api/v2/accounts?q=PITR' '' "$token" | jq -r '[.[].nickname] | sort | join(",")'
  else
    echo "（没有能登录的老板，跳过）"
  fi
}
# 库指纹：每张表的行数与内容摘要。在实例 Pod 里以 postgres 身份连
cnpg_psql() { local cluster=${CLUSTER:-pindou-db}; k exec -i "$cluster-1" -c postgres -- psql -d "${DB:-pindou}" -X -q -v ON_ERROR_STOP=1 "$@"; }
fingerprint() { # cnpg_psql 输出文件
  "$1" < "$ROOT/deploy/cnpg-fingerprint.sql" > "$2"
  grep -E '^ (ALL|migrations|locale|timezone|superuser)' "$2" | sed 's/^ /  /'
}
poll_start() { # 每 0.5 秒经 Traefik 探一次 /readyz，记「毫秒 状态码」
  local ip; ip=$(node_ip)
  rm -f "$DIR/poll.stop"
  (while [ ! -f "$DIR/poll.stop" ]; do
     code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 1 --resolve "$HOST:443:$ip" "https://$HOST/readyz" || true)
     echo "$(ms) $code"; sleep 0.5
   done) > "$DIR/poll.log" 2>/dev/null &
}
poll_stop() { # 打印连续不可用的时长
  touch "$DIR/poll.stop"; sleep 1
  awk '$2!=200 { if (!s) s=$1; e=$1; n++ } END { if (n) printf "  外部探测：%d 次不是 200，从第一次到最后一次 %.1f 秒\n", n, (e-s)/1000; else print "  外部探测：全部 200" }' "$DIR/poll.log"
}
# 等 API 滚动完成，再等经 Traefik 能访问（新 Pod 进端点、网络策略放行都要几秒）
wait_api() {
  k rollout status deploy/pindou-api --timeout=300s >/dev/null
  local ip; ip=$(node_ip)
  for _ in $(seq 1 60); do
    [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 2 --resolve "$HOST:443:$ip" "https://$HOST/readyz")" = 200 ] && return 0
    sleep 1
  done
  echo "!! 经 Traefik 访问不到 API" >&2; return 1
}

phase_up() {
  log "起 k3s（$K3S_IMAGE），ghcr.io 解析到 127.0.0.1"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -f "$DIR"/*.txt "$DIR"/*.dump "$DIR"/poll.*
  docker run -d --name "$NAME" --hostname "$NAME" --privileged --add-host ghcr.io:127.0.0.1 \
    --tmpfs /run --tmpfs /var/run -v "$VOLUME:/var/lib/rancher/k3s" -v "$ROOT:/repo:ro" \
    "$K3S_IMAGE" server --disable=metrics-server --write-kubeconfig-mode=600 >/dev/null
  for _ in $(seq 1 90); do docker exec "$NAME" test -f /etc/rancher/k3s/k3s.yaml 2>/dev/null && break; sleep 2; done
  docker cp -L "$NAME:/bin/k3s" "$DIR/k3s" >/dev/null
  ln -sf ../k3s "$DIR/bin/kubectl"
  docker exec "$NAME" cat /etc/rancher/k3s/k3s.yaml | sed "s#https://127.0.0.1:6443#https://$(node_ip):6443#" > "$KUBECONFIG"
  chmod 600 "$KUBECONFIG"
  for _ in $(seq 1 90); do kubectl get nodes 2>/dev/null | grep -q ' Ready' && break; sleep 2; done
  guard
  for _ in $(seq 1 90); do kubectl get crd ingressroutes.traefik.io >/dev/null 2>&1 && break; sleep 2; done
  kubectl -n kube-system rollout status deploy/traefik --timeout=300s 2>/dev/null || sleep 20
  kubectl get nodes -o wide
}

phase_prepare() {
  guard
  log "预拉 ghcr.io 镜像（容器里 ghcr.io 不通，按 digest 从国内镜像站拉）"
  local t; t=$(ms)
  docker exec "$NAME" sh /repo/deploy/k3s/cnpg-prepull.sh /repo/deploy/k3s/cnpg-images.txt
  echo "  预拉用时 $(since "$t") 秒"
  log "插件证书、运算符与插件"
  "$ROOT/deploy/k3s/cnpg-plugin-tls.sh"
  kubectl apply --server-side -k "$ROOT/deploy/k3s/cnpg-operator" >/dev/null
  kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager --timeout=300s
  kubectl -n cnpg-system rollout status deploy/barman-cloud --timeout=300s
  log "Secret：数据库账号与密码、本机归档库的访问密钥、API 环境（假微信）"
  kubectl create namespace pindou --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  k get secret pindou-postgres >/dev/null 2>&1 || k create secret generic pindou-postgres \
    --from-literal=username=pindou --from-literal=password="$(openssl rand -hex 24)" >/dev/null
  k get secret pindou-db-s3 >/dev/null 2>&1 || k create secret generic pindou-db-s3 \
    --from-literal=ACCESS_KEY_ID="pindou-$(openssl rand -hex 6)" --from-literal=ACCESS_SECRET_KEY="$(openssl rand -hex 24)" >/dev/null
  local pw; pw=$(k get secret pindou-postgres -o jsonpath='{.data.password}' | base64 -d)
  k create secret generic pindou-api-env --from-literal=PINDOU_DATABASE_URL="postgres://pindou:$pw@postgres:5432/pindou?sslmode=disable" \
    --from-literal=PINDOU_DEV_FAKE_WECHAT=1 --dry-run=client -o yaml | kubectl apply -f - >/dev/null
}

phase_db() {
  guard
  log "从零建库（pindou-db.yaml）"
  local t; t=$(ms)
  kubectl apply -f "$ROOT/deploy/k3s/pindou-db.yaml"
  k wait --for=condition=Ready cluster/pindou-db --timeout=900s
  echo "  建库到就绪：$(since "$t") 秒"
  echo "  pindou 是超级用户：$(cnpg_psql -tAc "SELECT rolsuper FROM pg_roles WHERE rolname='pindou'")"
  log "立即备份（ScheduledBackup immediate）与 WAL 归档"
  for _ in $(seq 1 120); do
    phase=$(k get backups -l cnpg.io/scheduled-backup=pindou-db-daily -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)
    [ "$phase" = completed ] || [ "$phase" = failed ] && break; sleep 5
  done
  k get backups
  # Ready 不代表归档正常（归档失败时集群照样 Ready），单独核对
  for _ in $(seq 1 60); do
    [ "$(k get cluster pindou-db -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")].status}')" = True ] && break; sleep 5
  done
  k get cluster pindou-db -o jsonpath='{range .status.conditions[*]}{.type}={.status} {end}'; echo
  [ "$(k get cluster pindou-db -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")].status}')" = True ] \
    || { echo "!! WAL 归档没有在工作" >&2; exit 1; }
  cnpg_psql -c 'SELECT archived_count, last_archived_wal, last_archived_time, failed_count FROM pg_stat_archiver'
}

phase_app() {
  guard
  log "起 API（pindou.yaml，假微信）"
  kubectl apply -f "$ROOT/deploy/k3s/pindou.yaml" >/dev/null
  wait_api
  if [ -n "${CNPG_REHEARSAL_DUMP:-}" ]; then
    log "导入 $CNPG_REHEARSAL_DUMP"
    k scale deploy/pindou-api --replicas=0 >/dev/null
    k wait --for=delete pod -l app.kubernetes.io/name=pindou-api --timeout=120s >/dev/null 2>&1 || true
    DB=postgres cnpg_psql -c 'DROP DATABASE pindou WITH (FORCE)' -c 'CREATE DATABASE pindou OWNER pindou'
    k exec -i pindou-db-1 -c postgres -- pg_restore -d pindou --no-owner --no-privileges --role=pindou --exit-on-error < "$CNPG_REHEARSAL_DUMP"
    k scale deploy/pindou-api --replicas=2 >/dev/null
    wait_api
  else
    log "经 API 造数据：一位老板、五位顾客、五张已付款订单"
    local owner token c i=0
    owner=$(register rehearsal-owner 鬼鬼老板 13800000000)
    # 与生产做法一致：老板的 UUID 放进 Secret 再重启（不用 set env，之后 apply 清单会把它冲掉）
    k patch secret pindou-api-env -p "{\"stringData\":{\"PINDOU_BOOTSTRAP_OWNER_ID\":\"$owner\"}}" >/dev/null
    k rollout restart deploy/pindou-api >/dev/null
    wait_api
    token=$(login rehearsal-owner)
    for nick in 张三 李四 王五 赵六 小明; do
      i=$((i + 1))
      c=$(register "rehearsal-c$i" "$nick" "1390000000$i")
      paid_order "$token" "$c" $((i * 1000 + 800)) "拼豆体验 $i"
    done
  fi
  api GET /readyz; echo
  echo "  迁移：库里最新 $(cnpg_psql -tAc 'SELECT max(version_id) FROM goose_db_version WHERE is_applied')，仓库最新 $(ls "$ROOT"/pindou-backend/internal/storage/migrations/*.sql | sed -E 's#.*/0*([0-9]+)_.*#\1#' | sort -n | tail -1)"
  log "手动跑一次 pg_dump 备份任务（连 postgres 服务）"
  k create job --from=cronjob/postgres-backup rehearsal-backup >/dev/null
  k wait --for=condition=complete job/rehearsal-backup --timeout=300s >/dev/null
  k logs job/rehearsal-backup -c dump | tail -1
  api GET /statusz | jq -c .backups.local
  fingerprint cnpg_psql "$DIR/fp-initial.txt"
  log "内存（容器 cgroup 实际用量）"
  docker exec "$NAME" crictl stats -o json 2>/dev/null | jq -r '.stats[] | "\(.attributes.labels["io.kubernetes.pod.namespace"])/\(.attributes.labels["io.kubernetes.pod.name"]) \(.attributes.metadata.name) \((.memory.workingSetBytes.value // "0" | tonumber) / 1048576 | floor)Mi"' | grep -E 'pindou|cnpg' | sort
}

phase_pitr() {
  guard
  log "按时间点恢复：写入甲 → 记下时刻 T → 写入乙 → 恢复到 T"
  local target
  write rehearsal-pitr-a "PITR甲$RUN" 13900000101 1111 "恢复点之前"
  sleep 2
  target=$(cnpg_psql -tAc "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")
  echo "  T = $target"
  sleep 2
  write rehearsal-pitr-b "PITR乙$RUN" 13900000102 2222 "恢复点之后"
  # 切一个 WAL 段，让乙所在的段也进归档（平时 archive_timeout 5 分钟内自动切）
  local seg; seg=$(cnpg_psql -tAc 'SELECT pg_walfile_name(pg_switch_wal())')
  for _ in $(seq 1 60); do
    [ "$(cnpg_psql -tAc "SELECT last_archived_wal >= '$seg' FROM pg_stat_archiver")" = t ] && break; sleep 2
  done
  echo "  已归档到 $seg"
  local t; t=$(ms)
  sed "s/__TARGET_TIME__/$target/" "$ROOT/deploy/k3s/pindou-db-pitr.yaml" | kubectl apply -f -
  k wait --for=condition=Ready cluster/pindou-db-pitr --timeout=900s
  echo "  恢复集群就绪：$(since "$t") 秒"
  CLUSTER=pindou-db-pitr cnpg_psql -c "SELECT a.nickname, count(o.id) AS orders FROM accounts a LEFT JOIN sales_orders o ON o.account_id = a.id WHERE a.nickname LIKE 'PITR%' GROUP BY 1 ORDER BY 1"
  echo "  主库里同样的查询："
  cnpg_psql -c "SELECT a.nickname, count(o.id) AS orders FROM accounts a LEFT JOIN sales_orders o ON o.account_id = a.id WHERE a.nickname LIKE 'PITR%' GROUP BY 1 ORDER BY 1"
  [ "$(CLUSTER=pindou-db-pitr cnpg_psql -tAc "SELECT count(*) FROM accounts WHERE nickname = 'PITR甲$RUN'")" = 1 ] \
    && [ "$(CLUSTER=pindou-db-pitr cnpg_psql -tAc "SELECT count(*) FROM accounts WHERE nickname = 'PITR乙$RUN'")" = 0 ] \
    && echo "  结果正确：T 之前的甲在，T 之后的乙不在" || { echo "!! 按时间点恢复的结果不对" >&2; exit 1; }

  log "整库回到 T：停 API，把恢复集群的库导回主库（导回本身也进归档，之后仍能回到导回之前）"
  poll_start
  local t0; t0=$(ms)
  k patch cronjob postgres-backup -p '{"spec":{"suspend":true}}' >/dev/null
  k scale deploy/pindou-api --replicas=0 >/dev/null
  k wait --for=delete pod -l app.kubernetes.io/name=pindou-api --timeout=120s >/dev/null 2>&1 || true
  k exec pindou-db-1 -c postgres -- pg_dump -d pindou --format=custom > "$DIR/before-pitr-apply.dump"
  k exec pindou-db-pitr-1 -c postgres -- pg_dump -d pindou --format=custom > "$DIR/pitr.dump"
  DB=postgres cnpg_psql -c 'DROP DATABASE pindou WITH (FORCE)' -c 'CREATE DATABASE pindou OWNER pindou'
  k exec -i pindou-db-1 -c postgres -- pg_restore -d pindou --no-owner --no-privileges --role=pindou --exit-on-error < "$DIR/pitr.dump"
  fingerprint cnpg_psql "$DIR/fp-main-after-pitr-apply.txt" >/dev/null
  CLUSTER=pindou-db-pitr fingerprint cnpg_psql "$DIR/fp-pitr.txt" >/dev/null
  if diff <(grep -vE '^ (superuser|locale|server)' "$DIR/fp-pitr.txt") <(grep -vE '^ (superuser|locale|server)' "$DIR/fp-main-after-pitr-apply.txt"); then
    echo "  主库与恢复集群的数据一致"
  else
    echo "!! 导回后不一致" >&2; exit 1
  fi
  k scale deploy/pindou-api --replicas=2 >/dev/null
  wait_api
  k patch cronjob postgres-backup -p '{"spec":{"suspend":false}}' >/dev/null
  echo "  整库回到 T 共停机 $(since "$t0") 秒"
  sleep 3
  poll_stop
  echo "  主库里的 PITR 顾客：$(pitr_accounts)"
  echo "  pindou 是超级用户：$(cnpg_psql -tAc "SELECT rolsuper FROM pg_roles WHERE rolname='pindou'")；表的属主：$(cnpg_psql -tAc "SELECT string_agg(DISTINCT tableowner, ',') FROM pg_tables WHERE schemaname='public'")"
  k delete cluster pindou-db-pitr --wait=true >/dev/null
  echo "  已删掉恢复集群（它用 local-path 存储类，卷随之删除）"
}

phase_down() {
  log "清理"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$DIR"
  echo "已删除容器 $NAME、数据卷 $VOLUME 和 $DIR"
}

[ $# -gt 0 ] || { sed -n '2,22p' "$0"; exit 1; }
[ "$1" = all ] && set -- up prepare db app pitr
for phase in "$@"; do
  case $phase in
    up | prepare | db | app | pitr | down) "phase_$phase" ;;
    *) echo "不认识的阶段：$phase" >&2; exit 1 ;;
  esac
done
