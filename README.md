# Duoheshui Web

面向移动端的“小天同学”饮水机非官方 Web 客户端。React SPA 与 Hono API 运行在同一个 Cloudflare Worker 域名下，D1 保存加密后的会话与设备关联数据。

> 本项目与“小天同学”及其官方服务无关联。只能用于本人账号及本人有权操作的饮水机。第三方接口变化可能导致功能失效。

## 已实现

- 支持手机号 + 账号密码或短信验证码登录；登录和短信发送均由 Cloudflare Turnstile 服务端校验保护，短信另有 60 秒/小时双层限速；密码只用于本次上游登录请求，不落库。
- 自有 HttpOnly、Secure、SameSite=Strict 会话，固定有效期 365 天；D1 仅保存 Session token 的 SHA-256。
- 页面加载时通过用户信息接口验证上游凭据并刷新余额；余额也可手动刷新，只有余额查询允许一次网络级重试。
- 用户信息、余额或出水响应明确表明 token 错误、失效或过期时，立即清除本地会话并返回登录页；普通网络故障不会触发注销，重新登录后保存的设备仍然保留。
- 支持保存多台常用饮水机；每台设备分别关联热水口和冷水口二维码，并可选择当前启用设备。
- 二维码在浏览器本地解码，画面不上传；API 不返回完整 device key。
- 支持临时设备扫码即解锁且不保存二维码；所有解锁无需二次确认，UUID 幂等、同类出水口三秒冷却且不自动重试。
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
             ├─ Cloudflare Turnstile Siteverify
             └─ Tianji adapter (DES-CBC / gptechMsg)
```

浏览器从不接触 Tianji token、DES key/IV、完整持久化 device key 或解密后的上游响应。

## 本地开发

要求 Node.js 22+ 与 pnpm。

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm wrangler d1 migrations apply duoheshui --local
pnpm dev
```

在未提交的 `.dev.vars` 中填写：

- `APP_DATA_KEY`：随机 32 字节的 base64url 字符串。
- `TIANJI_DES_KEY` / `TIANJI_DES_IV`：旧 Android 协议兼容值，各 8 字节。
- 两个 Tianji origin：按当前已确认的上游能力填写下文列出的 HTTP 地址。
- `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`：示例中使用 Cloudflare 官方测试密钥，仅限本地开发；生产环境必须替换成自己的真实密钥。

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
- Turnstile Siteverify 的成功、失败、重复令牌、上下文不匹配及服务不可用处理。
- 验证码发送、验证码/密码登录失败与成功、Session Cookie、加载时用户信息验证及余额刷新。
- 用户信息缺失、`auth=00001` 和 token 失效消息的自动注销处理。
- 多设备增删改、当前设备切换、旧热/冷水绑定迁移与完整 device key 不回传。
- 临时二维码仅使用一次且不进入设备列表。
- 未登录、未绑定设备、重复 requestId、三秒限流与热/冷启动。

所有测试使用 mock 上游，不会发送真实短信或真实出水指令。

## Cloudflare Dashboard + Git 部署

1. 把仓库推送到 GitHub 或 GitLab。不要提交 `.dev.vars`。
2. 在 Cloudflare Dashboard 的 **Storage & Databases → D1 SQL Database** 中创建数据库 `duoheshui`，复制 Database ID，把 `wrangler.jsonc` 中的全零占位 UUID 替换为真实 ID 后推送。
3. 将 `wrangler.jsonc` 中 `ratelimits[0].namespace_id` 改成当前 Cloudflare 账号内未使用的正整数标识。
4. 在 **Workers & Pages → Create application → Start with Hello World** 创建一个名称严格为 `duoheshui-web` 的 Worker。
5. 打开该 Worker 的 **Settings → Bindings → Add binding → D1 database**，变量名填写 `DB`，选择刚创建的 `duoheshui`。
6. 在 Cloudflare Dashboard 的 **Turnstile → Add widget** 创建一个 **Managed** 小组件，把 Worker 的 `*.workers.dev` 完整主机名以及实际自定义域名加入 Hostname Management，保存后复制 Site key 与 Secret key。
7. 在 Worker 的 **Settings → Variables and Secrets** 添加以下七个 Runtime Secret：
   - `APP_DATA_KEY`：随机 32 字节 base64url。
   - `TIANJI_DES_KEY`：Tianji 协议的 8 字节 key。
   - `TIANJI_DES_IV`：Tianji 协议的 8 字节 IV。
   - `TIANJI_USER_ORIGIN=http://newxiaotian.tianji-inc.com`
   - `TIANJI_IOT_ORIGIN=http://iot.tianji-inc.com`
   - `TURNSTILE_SITE_KEY`：上一步获得的公开 Site key；代码只通过 `/api/config` 将此值提供给登录页。
   - `TURNSTILE_SECRET_KEY`：上一步获得的 Secret key；仅用于 Worker 请求 Siteverify，绝不能提交到 Git 或发送给浏览器。
8. 打开 D1 数据库的 **Console**，依次粘贴并执行 `migrations/0001_init.sql`、`migrations/0002_multi_device.sql`、`migrations/0003_account_devices.sql` 的完整内容。第二个 migration 会把旧版账户已有的热/冷水绑定合并到一条默认启用的“原有设备”记录中；第三个 migration 让设备归属独立于会话，自动登出或重新登录不会删除设备。
9. 回到 Worker 的 **Settings → Builds → Connect**，授权 GitHub/GitLab 并选择仓库。生产分支选择实际默认分支，项目根目录为 `/`。
10. Build 配置：
   - Build command：`pnpm build`
   - Deploy command：`pnpm wrangler deploy`
   - Build variable：`NODE_VERSION=22`
   - Build variable：`PNPM_VERSION=11.19.0`
   - 不要把七个 Runtime Secret 错放到 Build Variables 中。
11. 保存并触发首次 Build。完成后访问 `https://duoheshui-web.<account>.workers.dev/api/health`，应返回 `{"ok":true,"data":{"status":"healthy"}}`；再打开登录页确认 Turnstile 正常显示。
12. 在 **Domains** 中可继续绑定自己的域名。新增或更换域名时，也要把新主机名加入 Turnstile 的 Hostname Management。部署域名确定后，把 `index.html` 中的 Open Graph / X 图片改为该域名下 `/og.png` 的绝对 HTTPS URL并再次推送。

如果选择命令行管理 migration，可在登录 Wrangler 后执行：

```bash
pnpm wrangler d1 migrations apply duoheshui --remote
```

已有线上版本升级时，必须先对远程 D1 执行尚未应用的 migration（本版本至少需要 `0003_account_devices.sql`），确认成功后再推送本次代码触发 Worker 部署；不要先部署读取 `account_hash` 的新 Worker。

## 上游明文 HTTP 说明

当前确认上游仅接受：

- `http://newxiaotian.tianji-inc.com`
- `http://iot.tianji-inc.com`

浏览器到 Worker 仍使用 HTTPS，但 **Worker 到 Tianji 的最后一段是明文 HTTP**。手机号、验证码和 device key 位于旧 DES 数据段；Tianji token 位于外层 `gptechMsg.header.token`，因此会在这段 HTTP 链路中以明文传输。该遗留协议存在被链路观察者截获和重放的风险，必须在上线前明确接受。浏览器绝不能直接请求旧 HTTP origin。

### 上游 502 排查

部署后，`tianji_request` 日志会给出不包含手机号、验证码、token 或请求正文的诊断字段：

- `outcome=http_error`：Worker 已收到源站响应，结合 `upstreamStatus` 判断源站错误。
- `outcome=timeout`：超过本项目设置的请求超时。
- `outcome=network_error`：Cloudflare 到源站的连接失败；`failureKind` 会进一步标记 `connection_lost`、`connection_refused`、`dns` 等类别。
- `tianji_business_response`：源站已返回 HTTP 200 后的业务判定，只记录脱敏后的 `businessCode`、`businessMessage` 与 `accepted`，不记录响应 `data`。只有明确的成功业务码或成功消息才会向网页报告短信已发送。

配置已通过 `placement.hostname` 请求 Cloudflare 将 API 执行位置放到更接近 `newxiaotian.tianji-inc.com` 的节点。首次部署后需要等待平台完成位置探测。若日志持续显示 `connection_lost` 或 `connection_refused`，说明旧源站或其防火墙拒绝 Cloudflare 出口链路，无法仅靠重试安全解决（验证码请求可能已经送达）；此时应把 `TIANJI_USER_ORIGIN` / `TIANJI_IOT_ORIGIN` 指向受控的 HTTPS 中继服务。

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
POST   /api/auth/login/password
POST   /api/auth/logout
GET    /api/config
GET    /api/me
POST   /api/balance/refresh
GET    /api/devices
POST   /api/devices
PATCH  /api/devices/:id
DELETE /api/devices/:id
POST   /api/devices/:id/activate
POST   /api/water/hot/start
POST   /api/water/cold/start
POST   /api/water/temporary/start
GET    /api/health
```

所有修改状态的 API 要求同源 `Origin` 以及 `X-Duoheshui-Client: web`。响应统一为 `{ ok: true, data }` 或 `{ ok: false, error }`。

## 复用边界

本实现根据已观察到的协议行为 clean-room 编写 TypeScript，没有复制原 Android App 的 UI、资源、图标或大段 Kotlin 源码。没有实现未经现有调用链证实的第二阶段 start API、服务器设备绑定、公共设备发现、批量控制或定时出水。
