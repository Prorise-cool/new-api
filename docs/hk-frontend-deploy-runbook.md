# HK 反代前端 dist 部署 Runbook

## 这份文档解决什么问题

new-api 的部署链路是**前后端解耦**的,香港(HK)反代节点的前端需要**单独手工部署**:

| 层 | 路径 | 谁来更新 | 机制 |
|----|------|---------|------|
| 后端 API(`/api` `/v1` `/v1beta`) | WDC `209.50.227.90` + SFO `23.106.46.111` | `push main` → GitHub Actions `deploy.yml` → `deploy/rollout.sh` | ✅ 自动滚动 |
| **前端(`/` 的 SPA dist)** | **HK `85.137.245.122`** 本地 `/opt/1panel/www/newapi-frontend/dist` | **手工**(本文档) | ❌ 无任何自动化 |

**关键认知**:HK 那台 **不跑 new-api 容器**,它是 1Panel + OpenResty 反代。`location /` 用 `root /www/newapi-frontend/dist` **本地 serve 前端静态文件**,只有 `/api/` `/v1/` `/v1beta/` 才 `proxy_pass` 回源 WDC/SFO。

所以:**只 push 触发 CI/CD,后端会更新,但 HK 上的前端 dist 不会变** —— 前端改动(新页面、新计费展示等)不手工部署到 HK 就永远不会出现在 `newapi.prorisehub.com`。

> 反代配置文件:HK `/opt/1panel/www/conf.d/newapi.prorisehub.com.conf`
> (= openresty 容器内 `/usr/local/openresty/nginx/conf/conf.d/`,挂载自宿主 `/opt/1panel/www`)

---

## HK 服务器信息

- IP:`85.137.245.122` 端口 `22` 用户 `root`
- 前端 dist 宿主路径:`/opt/1panel/www/newapi-frontend/dist`
- 备份命名:`dist.bak-<YYYYMMDD-HHMMSS>`(与 dist 同级)
- 上传暂存:`/opt/1panel/www/newapi-frontend/_upload_tmp/`

---

## 为什么这套流程是安全的(原理)

1. **内容哈希文件名**:rsbuild 产物是 `index.<hash>.js` / `index.<hash>.css`。改了代码 → 新 build = 新 hash = 新文件名,与旧文件不冲突。
2. **缓存策略天然正确**(HK nginx + 后端一致):
   - 带 hash 的 `.js/.css`:`expires 7d` + `immutable` → 可永久缓存,因为文件名变了浏览器会自动取新的。
   - `index.html`:走 ETag/Last-Modified 协商缓存,每次回源校验 → dist 换了就拿到引用新 hash 的新 HTML。
   - **结论:换 dist 后不白屏、不卡旧版,无需清任何缓存。**
3. **前后端上线顺序无所谓**:新后端 + 旧前端(旧前端忽略新字段)、新前端 + 旧后端(新组件自带 null-check 不渲染),两个方向都优雅降级。
4. **原子替换 + mv 备份**:用 `mv` 而非删除,旧版始终在 `dist.bak-*` 里,可秒级回滚。

---

## 部署流程

### 前置:本地 build(在 `web/default/`)

```bash
cd web/default
# 版本号注入(可选,但建议与后端 deploy tag 风格一致)
VITE_REACT_APP_VERSION="prod-$(date +%Y%m%d)-$(cd .. && git rev-parse --short HEAD)" \
  bun run build
# 记下新入口 hash,验证时要用
grep -oE '/static/js/index\.[a-z0-9]+\.js' dist/index.html
```

### 1. 打包(根除 macOS AppleDouble 垃圾)

macOS 上 build 的 dist 会带 `._*` / `.DS_Store`,必须排除,否则 nginx 目录里会有一堆 `._index.html` 垃圾。

```bash
cd web/default
COPYFILE_DISABLE=1 tar --exclude='._*' --exclude='.DS_Store' \
  -czf /tmp/newapi-dist.tgz -C dist .
# 校验包内无垃圾(应输出 0)
tar -tzf /tmp/newapi-dist.tgz | grep -cE '\._|\.DS_Store'
```

> 上传到 HK 后解包时会看到一堆 `tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance'` —— **这是无害警告**(只是 macOS xattr 元数据),文件内容完整,可忽略。

### 2. 上传到 HK 暂存区

```bash
scp /tmp/newapi-dist.tgz \
  root@85.137.245.122:/opt/1panel/www/newapi-frontend/_upload_tmp/newapi-dist.tgz
```

### 3. HK 上原子替换(先验证完整性,再切换 + 备份)

SSH 到 HK 执行。**这段脚本带 `set -e` 和完整性校验,任一步失败会中止,不会破坏现网。**

```bash
ssh root@85.137.245.122 'bash -s' <<'DEPLOY'
set -e
cd /opt/1panel/www/newapi-frontend
TS=$(date +%Y%m%d-%H%M%S)

# 1) 解包到临时目录(不碰现网)
rm -rf _upload_tmp/dist_new && mkdir -p _upload_tmp/dist_new
tar -xzf _upload_tmp/newapi-dist.tgz -C _upload_tmp/dist_new

# 2) 完整性校验:index.html 引用的所有 chunk 必须都在
MISSING=0
for ref in $(grep -oE '/static/[a-z]+/[^"]+\.(js|css)' _upload_tmp/dist_new/index.html); do
  test -f "_upload_tmp/dist_new${ref}" || { echo "✗ 缺失: $ref"; MISSING=$((MISSING+1)); }
done
test "$MISSING" -eq 0 || { echo "有 $MISSING 个 chunk 缺失,中止"; exit 1; }
echo "✓ 完整性校验通过"

# 3) 原子替换:mv 备份旧 dist → 切换新 dist(mv 是原子操作)
mv dist "dist.bak-${TS}"
mv _upload_tmp/dist_new dist
echo "✓ 已切换,旧版备份为 dist.bak-${TS}"

# 4) 清理上传包
rm -f _upload_tmp/newapi-dist.tgz
DEPLOY
```

### 4. 验证(从 HK 本地直连 openresty)

直连 IP 会 TLS 握手失败(SNI 不匹配),**必须用 `--resolve` 带真实域名**:

```bash
ssh root@85.137.245.122 'bash -s' <<'VERIFY'
R="--resolve newapi.prorisehub.com:443:127.0.0.1"
# index.html 应引用新 hash
curl -s $R https://newapi.prorisehub.com/ | grep -oE '/static/js/index\.[a-z0-9]+\.js'
# 新入口 chunk 应 200
curl -s $R -o /dev/null -w "新入口 -> HTTP %{http_code}\n" \
  https://newapi.prorisehub.com/static/js/$(curl -s $R https://newapi.prorisehub.com/ | grep -oE 'index\.[a-z0-9]+\.js' | head -1)
# 后端 API 仍正常(反代回源)
curl -s $R -o /dev/null -w "/api/status -> HTTP %{http_code}\n" \
  https://newapi.prorisehub.com/api/status
VERIFY
```

预期:index.html 引用新 hash、新入口 200、`/api/status` 200。

---

## 回滚(出问题时)

备份是 `mv` 来的完整目录,秒级回滚:

```bash
ssh root@85.137.245.122 'bash -s' <<'ROLLBACK'
set -e
cd /opt/1panel/www/newapi-frontend
# 列出可用备份,挑最近一个(或指定时间戳)
ls -dt dist.bak-* | head -5
LATEST=$(ls -dt dist.bak-* | head -1)
TS=$(date +%Y%m%d-%H%M%S)
mv dist "dist.failed-${TS}"      # 把坏的挪走(留作排查)
cp -a "$LATEST" dist             # 用 cp -a 还原,保留备份本体
echo "✓ 已回滚到 $LATEST"
ROLLBACK
```

> 回滚无需重启 openresty(serve 的是静态文件,目录一换即生效)。若浏览器仍显示旧版,是客户端缓存了 index.html,Ctrl+Shift+R 强刷即可——但因 index.html 走协商缓存,通常自动生效。

---

## 备份清理(可选,定期)

dist 约 60MB,备份会累积。保留最近 3 个,删更早的:

```bash
ssh root@85.137.245.122 'cd /opt/1panel/www/newapi-frontend && \
  ls -dt dist.bak-* | tail -n +4 | xargs -r rm -rf && \
  echo "已清理旧备份,保留最近 3 个" && ls -dt dist.bak-*'
```

---

## 完整一次性流程(复制即用)

后端用 CI/CD(push main),前端用下面这条龙。**改了前端代码后执行:**

```bash
# === 本地 ===
cd web/default
VITE_REACT_APP_VERSION="prod-$(date +%Y%m%d)-$(cd .. && git rev-parse --short HEAD)" bun run build
NEW_HASH=$(grep -oE 'index\.[a-z0-9]+\.js' dist/index.html | head -1)
echo "本次入口: $NEW_HASH"
COPYFILE_DISABLE=1 tar --exclude='._*' --exclude='.DS_Store' -czf /tmp/newapi-dist.tgz -C dist .
scp /tmp/newapi-dist.tgz root@85.137.245.122:/opt/1panel/www/newapi-frontend/_upload_tmp/newapi-dist.tgz

# === HK 原子替换 ===
ssh root@85.137.245.122 'bash -s' <<'DEPLOY'
set -e
cd /opt/1panel/www/newapi-frontend
TS=$(date +%Y%m%d-%H%M%S)
rm -rf _upload_tmp/dist_new && mkdir -p _upload_tmp/dist_new
tar -xzf _upload_tmp/newapi-dist.tgz -C _upload_tmp/dist_new
MISSING=0
for ref in $(grep -oE '/static/[a-z]+/[^"]+\.(js|css)' _upload_tmp/dist_new/index.html); do
  test -f "_upload_tmp/dist_new${ref}" || MISSING=$((MISSING+1))
done
test "$MISSING" -eq 0 || { echo "✗ $MISSING chunk 缺失,中止"; exit 1; }
mv dist "dist.bak-${TS}" && mv _upload_tmp/dist_new dist
rm -f _upload_tmp/newapi-dist.tgz
echo "✓ 部署完成,备份 dist.bak-${TS}"
R="--resolve newapi.prorisehub.com:443:127.0.0.1"
curl -s $R https://newapi.prorisehub.com/ | grep -oE '/static/js/index\.[a-z0-9]+\.js'
curl -s $R -o /dev/null -w "/api/status -> HTTP %{http_code}\n" https://newapi.prorisehub.com/api/status
DEPLOY
```

---

## 未来改���(可选)

把前端部署也接入 `deploy.yml`:build dist → tar → `scp` 到 HK → SSH 原子替换。需要给 GitHub Actions 配 HK 的 deploy SSH key(加到 HK `authorized_keys`),复用本文档第 3 步的脚本逻辑。这样 `push main` 就能前后端一起自动上线,免去手工。

> 注意:HK 不在 `deploy/nodes.json`(那是 new-api 容器节点清单,HK 不跑容器),前端部署要作为 `deploy.yml` 里**独立的 job**,不要混进 `rollout.sh`。
