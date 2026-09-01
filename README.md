# Duoheshui Web

面向移动端的“小天同学”饮水机非官方 Web 客户端。React SPA 与 Hono API 运行在同一个 Cloudflare Worker 域名下，D1 保存加密后的会话与设备关联数据。

> 本项目与“小天同学”及其官方服务无关联。只能用于本人账号及本人有权操作的饮水机。第三方接口变化可能导致功能失效。

## 已实现

- 手机号 + 短信验证码登录，60 秒/小时双层短信限速。
- 自有 HttpOnly、Secure、SameSite=Strict 会话，固定有效期 365 天；D1 仅保存 Session token 的 SHA-256。
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

## Cloudflare Dashboard + Git 部署

1. 把仓库推送到 GitHub 或 GitLab。不要提交 `.dev.vars`。
2. 在 Cloudflare Dashboard 的 **Storage & Databases → D1 SQL Database** 中创建数据库 `duoheshui`，复制 Database ID，把 `wrangler.jsonc` 中的全零占位 UUID 替换为真实 ID 后推送。
3. 将 `wrangler.jsonc` 中 `ratelimits[0].namespace_id` 改成当前 Cloudflare 账号内未使用的正整数标识。
4. 在 **Workers & Pages → Create application → Start with Hello World** 创建一个名称严格为 `duoheshui-web` 的 Worker。
5. 打开该 Worker 的 **Settings → Bindings → Add binding → D1 database**，变量名填写 `DB`，选择刚创建的 `duoheshui`。
6. 在 **Settings → Variables and Secrets** 添加以下五个 Runtime Secret：
   - `APP_DATA_KEY`：随机 32 字节 base64url。
   - `TIANJI_DES_KEY`：Tianji 协议的 8 字节 key。
   - `TIANJI_DES_IV`：Tianji 协议的 8 字节 IV。
   - `TIANJI_USER_ORIGIN=http://newxiaotian.tianji-inc.com`
   - `TIANJI_IOT_ORIGIN=http://iot.tianji-inc.com`
7. 打开 D1 数据库的 **Console**，粘贴并执行 `migrations/0001_init.sql` 的完整内容。Migration 使用 `IF NOT EXISTS`，以后再通过 Wrangler 应用也不会重复建表失败。
8. 回到 Worker 的 **Settings → Builds → Connect**，授权 GitHub/GitLab 并选择仓库。生产分支选择实际默认分支，项目根目录为 `/`。
9. Build 配置：
   - Build command：`pnpm build`
   - Deploy command：`pnpm wrangler deploy`
   - Build variable：`NODE_VERSION=22`
   - Build variable：`PNPM_VERSION=11.19.0`
   - 不要把五个 Runtime Secret 错放到 Build Variables 中。
10. 保存并触发首次 Build。完成后访问 `https://duoheshui-web.<account>.workers.dev/api/health`，应返回 `{"ok":true,"data":{"status":"healthy"}}`。
11. 在 **Domains** 中可继续绑定自己的域名。部署域名确定后，把 `index.html` 中的 Open Graph / X 图片改为该域名下 `/og.png` 的绝对 HTTPS URL并再次推送。

如果选择命令行管理 migration，可在登录 Wrangler 后执行：

```bash
pnpm wrangler d1 migrations apply duoheshui --remote
```

## 上游明文 HTTP 说明

当前确认上游仅接受：

- `http://newxiaotian.tianji-inc.com`
- `http://iot.tianji-inc.com`

浏览器到 Worker 仍使用 HTTPS，但 **Worker 到 Tianji 的最后一段是明文 HTTP**。手机号、验证码和 device key 位于旧 DES 数据段；Tianji token 位于外层 `gptechMsg.header.token`，因此会在这段 HTTP 链路中以明文传输。该遗留协议存在被链路观察者截获和重放的风险，必须在上线前明确接受。浏览器绝不能直接请求旧 HTTP origin。

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
