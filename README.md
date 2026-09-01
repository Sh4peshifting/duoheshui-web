# Duoheshui Web

面向移动端的“小天同学”饮水机非官方 Web 客户端。React SPA 与 Hono API 运行在同一个 Cloudflare Worker 域名下，D1 保存加密后的会话与设备关联数据。

> 本项目与“小天同学”及其官方服务无关联。只能用于本人账号及本人有权操作的饮水机。第三方接口变化可能导致功能失效。

## 已实现

- 手机号 + 短信验证码登录，60 秒/小时双层短信限速。
- 自有 HttpOnly、Secure、SameSite=Strict 会话；D1 仅保存 Session token 的 SHA-256。
- 余额缓存与手动刷新；只有余额查询允许一次网络级重试。
- 热水/冷水二维码分别关联，可相机扫描或手工粘贴。
- 二维码在浏览器本地解码，画面不上传；API 不返回完整 device key。
- 热水启动二次确认、UUID 幂等、同类设备三秒冷却；出水指令不自动重试。
- DES-CBC Tianji 协议适配器、AES-256-GCM 数据加密、统一 API 错误、安全响应头和敏感日志约束。

## 架构

```text
Mobile Browser (HTTPS)
  ├─ React static assets
  └─ /api/*
        └─ Cloudflare Worker / Hono
             ├─ D1 (encrypted sessions and device keys)
             ├─ Worker Secrets
             ├─ Rate Limiting binding
             └─ Tianji adapter (DES-CBC / gptechMsg)
```

浏览器从不接触 Tianji token、DES key/IV、完整持久化 device key 或解密后的上游响应。

## 本地开发

要求 Node.js 20+ 与 pnpm。

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm wrangler d1 migrations apply duoheshui --local
pnpm dev
```

在未提交的 `.dev.vars` 中填写：

- `APP_DATA_KEY`：随机 32 字节的 base64url 字符串。
- `TIANJI_DES_KEY` / `TIANJI_DES_IV`：旧 Android 协议兼容值，各 8 字节。
- 两个 Tianji origin：默认应使用 HTTPS。

可以用 Node.js 生成 `APP_DATA_KEY`：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`.dev.vars` 已被 Git 忽略，不要提交真实密钥。

## 验证

```bash
pnpm test
pnpm typecheck
pnpm build
```

测试覆盖：

- 三组固定 DES-CBC 向量的双向一致性。
- gptechMsg 字段、每次生成新 `msg_id`、只进行一次 form encoding。
- 验证码发送、登录失败、登录成功、Session Cookie、余额刷新。
- hot/cold 分槽保存、完整 device key 不回传。
- 未登录、未绑定设备、重复 requestId、三秒限流与热/冷启动。

所有测试使用 mock 上游，不会发送真实短信或真实出水指令。

## Cloudflare 部署

1. 创建 D1，并把返回的数据库 UUID 写入 `wrangler.jsonc`：

   ```bash
   pnpm wrangler d1 create duoheshui
   ```

2. 将 `ratelimits[].namespace_id` 改为 Cloudflare 账号内未使用的正整数标识。
3. 应用远端 migration：

   ```bash
   pnpm wrangler d1 migrations apply duoheshui --remote
   ```

4. 逐项设置 Secrets（不要写入 `wrangler.jsonc`）：

   ```bash
   pnpm wrangler secret put APP_DATA_KEY
   pnpm wrangler secret put TIANJI_DES_KEY
   pnpm wrangler secret put TIANJI_DES_IV
   pnpm wrangler secret put TIANJI_USER_ORIGIN
   pnpm wrangler secret put TIANJI_IOT_ORIGIN
   ```

5. 构建并部署：

   ```bash
   pnpm build
   pnpm wrangler deploy
   ```

部署域名确定后，把 `index.html` 中的 Open Graph / X 图片地址改成该可信域名下 `/og.png` 的绝对 HTTPS URL。

## 上游 TLS 说明

实现默认请求：

- `https://newxiaotian.tianji-inc.com`
- `https://iot.tianji-inc.com`

真实账号 smoke test 前必须确认 HTTPS 端点与旧 HTTP 端点响应一致。如果上游确实只接受 HTTP，可以通过 Secret 把 origin 改为 `http://...`；此时浏览器到 Worker 仍为 HTTPS，但 **Worker 到 Tianji 的最后一段是明文 HTTP**，应在上线风险评估中明确接受这一点。浏览器绝不能直接请求旧 HTTP origin。

## 真实账号 smoke test

只能由账号及设备所有者执行，并按以下顺序进行：

1. 发送一次验证码并登录。
2. 验证余额返回。
3. 保存本人冷水设备二维码并执行一次冷水。
4. 现场确认设备动作后，再验证热水。

不要先测试热水，不要进行批量账号、批量设备扫描或自动化出水。如果上游结构与适配器预期不同，应停止猜测，只保留脱敏后的结构信息用于协议 diff。

## API

```text
POST   /api/auth/send-code
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/me
POST   /api/balance/refresh
GET    /api/devices
PUT    /api/devices/hot
PUT    /api/devices/cold
DELETE /api/devices/hot
DELETE /api/devices/cold
POST   /api/water/hot/start
POST   /api/water/cold/start
GET    /api/health
```

所有修改状态的 API 要求同源 `Origin` 以及 `X-Duoheshui-Client: web`。响应统一为 `{ ok: true, data }` 或 `{ ok: false, error }`。

## 复用边界

本实现根据已观察到的协议行为 clean-room 编写 TypeScript，没有复制原 Android App 的 UI、资源、图标或大段 Kotlin 源码。没有实现未经现有调用链证实的第二阶段 start API、服务器设备绑定、公共设备发现、批量控制或定时出水。
