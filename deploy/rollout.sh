#!/usr/bin/env bash
#
# new-api 滚动部署脚本(清单驱动)
# 读取 deploy/nodes.json,按 role(master 先于 slave)逐台滚动更新:
#   ghcr 登录(幂等) -> docker compose pull -> up -d -> 双因子健康门控
#   -> 任一节点失败即停并回滚该节点(坏版本不会铺满全网)。
#
# 用法:
#   IMAGE_TAG=prod-20260621-abc1234 \
#   SSH_KEY_FILE=~/.ssh/newapi-deploy \
#   [GHCR_USER=Prorise-cool GHCR_PULL_TOKEN=ghp_xxx] \
#   [INVENTORY=deploy/nodes.json] \
#   ./deploy/rollout.sh [--dry-run]
#
# 增删/换服务器:只改 deploy/nodes.json + 给新节点 authorized_keys 加 deploy 公钥。
# 节点侧依赖:docker + docker compose v2。本机/CI 侧依赖:jq、ssh。
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVENTORY="${INVENTORY:-$SCRIPT_DIR/nodes.json}"

: "${IMAGE_TAG:?需要 IMAGE_TAG(要部署的镜像 tag)}"
: "${SSH_KEY_FILE:?需要 SSH_KEY_FILE(deploy 私钥路径)}"
command -v jq >/dev/null || { echo "缺少 jq" >&2; exit 1; }
[[ -f "$INVENTORY" ]] || { echo "找不到清单: $INVENTORY" >&2; exit 1; }

IMAGE_REPO="$(jq -r '.image' "$INVENTORY")"
HEALTH_TIMEOUT="$(jq -r '.health_timeout_secs // 180' "$INVENTORY")"
FULL_IMAGE="${IMAGE_REPO}:${IMAGE_TAG}"

SSH_OPTS=(-i "$SSH_KEY_FILE" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
          -o BatchMode=yes -o LogLevel=ERROR -o ServerAliveInterval=15)

# master 排在 slave 前(稳定排序);用 while-read 兼容 bash 3.2(macOS)无 mapfile
NODES=()
while IFS= read -r _line; do NODES+=("$_line"); done \
  < <(jq -c '.nodes | sort_by(if .role=="master" then 0 else 1 end) | .[]' "$INVENTORY")
[[ ${#NODES[@]} -gt 0 ]] || { echo "清单无节点" >&2; exit 1; }

order=$(printf '%s\n' "${NODES[@]}" | jq -rs 'map(.name+"("+.role+")")|join(" -> ")')
echo "==> 目标镜像: $FULL_IMAGE"
echo "==> 部署顺序: $order"
[[ $DRY_RUN -eq 1 ]] && echo "==> [DRY-RUN] 仅验证连通与当前健康,不改动任何节点"

deploy_one() {
  local node="$1" name host port user dir svc cont health role
  name=$(jq -r '.name'           <<<"$node")
  host=$(jq -r '.host'           <<<"$node")
  port=$(jq -r '.port // 22'     <<<"$node")
  user=$(jq -r '.user // "root"' <<<"$node")
  dir=$(jq -r '.compose_dir'     <<<"$node")
  svc=$(jq -r '.service'         <<<"$node")
  cont=$(jq -r '.container'      <<<"$node")
  health=$(jq -r '.health_url'   <<<"$node")
  role=$(jq -r '.role'           <<<"$node")

  echo ""
  echo "########## [$name] $host  ($role) ##########"

  if [[ $DRY_RUN -eq 1 ]]; then
    ssh "${SSH_OPTS[@]}" -p "$port" "$user@$host" bash -s -- "$cont" "$health" <<'REMOTE'
set -e
cont="$1"; health="$2"
echo "  当前镜像: $(docker inspect -f '{{.Config.Image}}' "$cont" 2>/dev/null || echo 无)"
echo "  /api/status HTTP: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$health" || echo 无响应)"
REMOTE
    echo "  [dry-run] 将执行: cd $dir && NEWAPI_TAG=$IMAGE_TAG docker compose pull $svc && up -d $svc"
    return 0
  fi

  # 1) 回滚锚点(部署前当前镜像)
  local prev_image
  prev_image=$(ssh "${SSH_OPTS[@]}" -p "$port" "$user@$host" \
    docker inspect -f '{{.Config.Image}}' "$cont" 2>/dev/null | tr -d '\r' | tail -1 || true)
  echo "  回滚锚点: ${prev_image:-无}"

  # 2) 部署:ghcr 登录兜底 + pull + up;NEWAPI_TAG 走 shell 环境,绝不触碰 .env
  # 注意:空参数经 ssh 重新分词会被吞掉导致位置参数错位,故用哨兵 NONE 占位
  if ! ssh "${SSH_OPTS[@]}" -p "$port" "$user@$host" bash -s -- \
      "$dir" "$svc" "$IMAGE_TAG" "${GHCR_PULL_TOKEN:-NONE}" "${GHCR_USER:-NONE}" <<'REMOTE'
set -euo pipefail
dir="$1"; svc="$2"; tag="$3"; token="$4"; ghuser="$5"
cd "$dir"
if [ "$token" != "NONE" ] && [ -n "$token" ]; then
  echo "$token" | docker login ghcr.io -u "$ghuser" --password-stdin >/dev/null 2>&1 \
    || echo "  warn: ghcr 登录失败(包若为 public 可忽略)"
fi
NEWAPI_TAG="$tag" docker compose pull "$svc"
NEWAPI_TAG="$tag" docker compose up -d --no-deps "$svc"
REMOTE
  then
    echo "  ❌ [$name] pull/up 命令失败(见上方报错)" >&2
    return 1
  fi

  # 3) 双因子健康门控:镜像就位 + /api/status success
  echo "  等待健康(超时 ${HEALTH_TIMEOUT}s)..."
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) ok=0
  while (( SECONDS < deadline )); do
    if ssh "${SSH_OPTS[@]}" -p "$port" "$user@$host" bash -s -- \
        "$cont" "$FULL_IMAGE" "$health" <<'REMOTE' >/dev/null 2>&1
set -e
cont="$1"; want="$2"; health="$3"
[ "$(docker inspect -f '{{.Config.Image}}' "$cont")" = "$want" ]
curl -sf --max-time 5 "$health" | grep -q '"success":[[:space:]]*true'
REMOTE
    then ok=1; break; fi
    sleep 5
  done

  if [[ $ok -eq 1 ]]; then
    echo "  ✅ [$name] 新镜像就位且健康"
    return 0
  fi

  # 4) 失败即停 + 回滚该台
  echo "  ❌ [$name] 健康门控超时" >&2
  if [[ -n "$prev_image" && "$prev_image" != "$FULL_IMAGE" ]]; then
    local prev_tag="${prev_image##*:}"
    echo "  回滚 [$name] -> :$prev_tag"
    ssh "${SSH_OPTS[@]}" -p "$port" "$user@$host" bash -s -- "$dir" "$svc" "$prev_tag" <<'REMOTE' || true
set -e
dir="$1"; svc="$2"; tag="$3"
cd "$dir"
NEWAPI_TAG="$tag" docker compose up -d --no-deps "$svc"
REMOTE
  fi
  return 1
}

rc=0
for node in "${NODES[@]}"; do
  deploy_one "$node" || { rc=1; break; }
done

echo ""
if [[ $rc -eq 0 ]]; then
  echo "==> ✅ 全部节点部署成功: $FULL_IMAGE"
else
  echo "==> ❌ 部署失败(故障节点已回滚,已停止后续)。" >&2
fi
exit $rc
