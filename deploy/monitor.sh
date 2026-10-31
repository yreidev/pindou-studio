#!/usr/bin/env bash
# 线上巡检：GitHub Actions 每小时跑一次（.github/workflows/monitor.yml），任何一项不过就让任务失败，
# GitHub 给仓库维护者发邮件。本机也能跑，但本机代理可能把请求转到别处（见 docs/deployment.md），以 Actions 的结果为准。
#
# 检查：API 存活与就绪；网页后台能打开且带 CSP；顾客域名的网页桌码说明页；最近一次本机备份（REQUIRE_OFFSITE=true 时还有异地备份）
# 不超过 MAX_BACKUP_AGE_HOURS 小时；各域名的证书离过期不少于 CERT_MIN_DAYS 天，且证书链最终由 ISRG Root X1 签发。
set -uo pipefail

# 小程序接口和网页桌码在同一个域名下
API=${PINDOU_API_HOST:-pindou.example.invalid}
ADMIN=${PINDOU_ADMIN_HOST:-admin.example.invalid}
CUSTOMER=${PINDOU_CUSTOMER_HOST:-pindou.example.invalid}
MAX_BACKUP_AGE_HOURS=${MAX_BACKUP_AGE_HOURS:-26}
REQUIRE_OFFSITE=${REQUIRE_OFFSITE:-false}
CERT_MIN_DAYS=${CERT_MIN_DAYS:-14}

failures=0
fail() {
  echo "::error::$*"
  failures=$((failures + 1))
}
ok() { echo "ok    $*"; }
# 国外的执行机到国内服务器偶尔丢包：重试几次再算失败
get() { curl -sS --retry 3 --retry-all-errors --retry-delay 5 --max-time 20 "$@"; }

for path in healthz readyz; do
  code=$(get -o /dev/null -w '%{http_code}' "https://$API/$path") || code=000
  if [ "$code" = 200 ]; then ok "$API/$path"; else fail "https://$API/$path 返回 $code"; fi
done

headers=$(get -D - -o /dev/null "https://$ADMIN/login" | tr -d '\r') || headers=''
if printf '%s\n' "$headers" | head -1 | grep -q ' 200'; then ok "$ADMIN/login"; else fail "网页后台打不开：$(printf '%s\n' "$headers" | head -1)"; fi
if printf '%s\n' "$headers" | grep -qi '^content-security-policy:'; then ok "$ADMIN CSP"; else fail "网页后台缺 Content-Security-Policy"; fi

# 顾客网页 2026-10-31 下线：不用微信扫网页桌码时打开的是后端给的「请用微信扫码」说明页（不带脚本）
page=$(get -D - "https://$CUSTOMER/t" | tr -d '\r') || page=''
if printf '%s\n' "$page" | head -1 | grep -q ' 200'; then ok "$CUSTOMER/t"; else fail "网页桌码的说明页打不开：$(printf '%s\n' "$page" | head -1)"; fi
if printf '%s\n' "$page" | grep -qi "^content-security-policy:.*default-src 'none'"; then ok "$CUSTOMER CSP"; else fail "网页桌码的说明页缺 CSP"; fi
if printf '%s\n' "$page" | grep -q '请用微信扫码'; then ok "$CUSTOMER 说明页内容"; else fail "网页桌码的说明页内容不对"; fi

status=$(get "https://$API/statusz") || status=''
backup() {
  local kind=$1 required=$2 finished age
  if ! finished=$(printf '%s' "$status" | jq -er ".backups.$kind.finishedAt // empty" 2>/dev/null); then
    if [ "$required" = true ]; then fail "没有成功过的 $kind 备份（/statusz：${status:0:200}）"; else echo "skip  $kind 备份未配置"; fi
    return
  fi
  age=$((($(date +%s) - $(date -d "$finished" +%s)) / 3600))
  if [ "$age" -le "$MAX_BACKUP_AGE_HOURS" ]; then ok "$kind 备份 $finished（${age} 小时前）"; else fail "$kind 备份已 ${age} 小时没有成功（最近一次 $finished）"; fi
}
backup local true
backup offsite "$REQUIRE_OFFSITE"

# WAL 归档（数据库开了归档才有）：卡着时集群照样 Ready、API 照样能用，只是 WAL 堆在数据盘上、按时间点恢复无从谈起
if ! wal=$(printf '%s' "$status" | jq -ec '.walArchive // empty' 2>/dev/null); then
  echo "skip  WAL 归档未开启"
elif [ "$(printf '%s' "$wal" | jq -r .failing)" = true ]; then
  fail "WAL 归档卡着：最近一次失败 $(printf '%s' "$wal" | jq -r .lastFailedAt)，最近一次成功 $(printf '%s' "$wal" | jq -r '.lastArchivedAt // "从没有"')"
else
  ok "WAL 归档正常（最近一次 $(printf '%s' "$wal" | jq -r '.lastArchivedAt // "还没有"')）"
fi

for host in $(printf '%s\n' "$API" "$ADMIN" "$CUSTOMER" | sort -u); do
  chain=$(echo | timeout 30 openssl s_client -connect "$host:443" -servername "$host" -showcerts 2>/dev/null)
  if [ -z "$chain" ]; then
    fail "$host 的证书取不到"
    continue
  fi
  end=$(printf '%s\n' "$chain" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  days=$((($(date -d "$end" +%s) - $(date +%s)) / 86400))
  if [ "$days" -ge "$CERT_MIN_DAYS" ]; then ok "$host 证书还有 $days 天"; else fail "$host 证书 $days 天后过期（自动续期可能坏了）"; fi
  # 按链最顶一张的签发者判断，不按张数：老手机只认 ISRG Root X1
  top=$(printf '%s\n' "$chain" | sed -n '/^Certificate chain/,/^---$/p' | grep -E '^ +i:' | tail -1)
  if printf '%s' "$top" | grep -q 'ISRG Root X1'; then ok "$host 证书链顶端 ISRG Root X1"; else fail "$host 证书链顶端不是 ISRG Root X1：$top"; fi
done

if [ "$failures" -gt 0 ]; then
  echo "$failures 项不通过"
  exit 1
fi
echo "全部通过"
