# Duoheshui Web / Cloudflare Serverless 实现规格

## 1. 项目目标

将 GitHub 项目 `aixiao0621/Duoheshui` 中已经存在的“小天同学”第三方接口逻辑重构成一个移动端友好的 Web App。

需要实现：

1. 手机号 + 短信验证码登录。
2. 保存登录会话。
3. 查询当前钱包余额。
4. 添加/扫描饮水机二维码。
5. 分别保存“热水”和“冷水”设备。
6. 点击按钮启动热水或冷水。
7. 完全部署在 Cloudflare Workers 上。
8. React SPA 和 Serverless API 使用同域名。
9. 所有上游 token、设备 key、协议加密均只在 Worker 后端处理。
10. 不要求 Android App，不依赖长期运行的服务器。

推荐技术栈：

- TypeScript
- React
- Vite
- Cloudflare Workers
- Cloudflare Vite Plugin
- Hono
- Zod
- Cloudflare D1
- Cloudflare Secrets
- Cloudflare Workers Rate Limiting
- Vitest / Workers test environment

不要直接把 Android Kotlin 代码翻译成前端 JavaScript。应把其网络协议 clean-room 重写成 Worker 中的 TypeScript adapter。

---

# 2. 可行性判断

## 登录

原 Android 项目不是用户名密码登录，而是：

手机号 → 请求短信验证码 → 手机号 + 验证码登录 → 获得 token。

相关调用位于 `Login.kt`，登录服务器为：

- scheme：`http`
- host：`newxiaotian.tianji-inc.com`

接口：

- `/api/v1/UserApi/sendCode`
- `/api/v1/UserApi/loginByCode`

请求均使用 POST + `application/x-www-form-urlencoded`，核心字段为：

`gptechMsg`

源码依据：

因此 Web 端可以实现，但请求不能直接从浏览器发送给旧 HTTP Origin，而应：

Browser → HTTPS Cloudflare Worker → Tianji API

Cloudflare Worker 的 Fetch API 可以发起外部 HTTP 请求。

---

# 3. 小天同学协议

## 3.1 DES 算法

Android 原项目：

- Algorithm：DES
- Mode：CBC
- Padding：PKCS5Padding
- Key ASCII：`5yoOxt9w`
- IV ASCII：`20190829`
- 输出：标准 Base64

源码依据：

注意：

DES block size 为 8 字节，因此这里的 PKCS5Padding 实际可以按照标准 PKCS#5/PKCS#7 的 8-byte block padding 实现。

所有加密均使用 UTF-8。

Worker 中建立：

`encryptTianjiPayload(plaintext: string): string`

以及：

`decryptTianjiPayload(ciphertextBase64: string): string`

优先尝试 Workers 的 `node:crypto`。

如果：

`createCipheriv("des-cbc", ...)`

在实际 Workers runtime 因 legacy cipher 被拒绝，则改用纯 TypeScript / pure-JS DES-CBC 实现。

不要把这个逻辑放在浏览器 bundle 中。

Cloudflare 当前提供 Node crypto cipher/decipher 能力，但仍必须针对 DES-CBC 做运行时测试。

### 必须通过的加密测试向量

精确明文：

`{"mobile":"13800138000","type":"login"}`

对应 Base64：

`JibQ81u7wO6og4g4ER7S7umfOtviVQi13NL9YzQdLZ1Vjgy9AMaOpA==`

精确明文：

`{"code":"123456","mobile":"13800138000"}`

对应 Base64：

`LxwbH1X3vElemm7vMr1NMNzKdzQ1Pw88sLxMUsf2f5fhmqs4pmfSjdxgeDCSPJ9a`

精确明文：

`{"device_key":"TEST_DEVICE"}`

对应 Base64：

`NoMgrusfOaMomM516cZP0bMfx9NVQ9VxKwl4ATfPVgQ=`

如果这些测试不能全部通过，不允许继续联调线上 API。

---

# 4. gptechMsg 协议

构造统一函数：

`buildGptechMessage(act, encryptedData, token?)`

返回：

```json
{
  "data": "<DES BASE64>",
  "header": {
    "act": "<ACTION>",
    "device_type": "android",
    "msg_id": 1690000000000,
    "source_model": "lg_LM-G820",
    "source_sys_version": "rkq1.210420.001",
    "source_version": "1.4.1",
    "token": "",
    "uuid": ""
  }
}
```

字段值来自 Android 项目。

改进原代码：

`msg_id` 必须每次调用使用：

`Date.now()`

不要像 Android 原代码一样在模块初始化时只计算一次。

最终 POST：

```text
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
```

body：

```text
gptechMsg=<URL encoded outer JSON>
```

TypeScript 使用：

```ts
new URLSearchParams({
  gptechMsg: JSON.stringify(message)
}).toString()
```

不要手工重复 urlencode。

不要主动设置：

- `Host`
- `Connection`
- `Accept-Encoding`

这些是 HTTP/runtime 管理的 headers。

可以设置：

- `Accept-Language: zh-CN,zh;q=0.8`
- 合理的 `User-Agent`
- `Cache-Control: no-cache`

---

# 5. 短信验证码

内部 API：

`POST /api/auth/send-code`

请求：

```json
{
  "mobile": "13800138000"
}
```

校验：

- 中国大陆手机号格式基础检查。
- 不记录明文验证码。
- 请求体最大约 1KB。
- 防止重复短信轰炸。

生成上游 plaintext：

```json
{
  "mobile": "13800138000",
  "type": "login"
}
```

DES encrypt。

outer header：

```json
{
  "act": "sendCode",
  "token": ""
}
```

上游：

host：

`newxiaotian.tianji-inc.com`

path：

`/api/v1/UserApi/sendCode`

禁止自动 retry。

短信发送必须做限速。

建议：

- 同一手机号 60 秒最多 1 次。
- 每小时最多 5 次。
- 全局再加一个较宽松限制。

使用 Workers Rate Limiting binding；Cloudflare 原生支持 Worker 内按业务 key 做限制。

---

# 6. 登录

内部 API：

`POST /api/auth/login`

request：

```json
{
  "mobile": "13800138000",
  "code": "123456"
}
```

plaintext：

```json
{
  "code": "123456",
  "mobile": "13800138000"
}
```

outer：

```json
{
  "header": {
    "act": "loginByCode",
    "token": ""
  }
}
```

上游 path：

`/api/v1/UserApi/loginByCode`

Android 项目会读取上游 JSON 的 `data` 字段，然后 DES 解密。

解密后的核心结构为：

```ts
interface TianjiUser {
  mobile: string;
  token: string;
  wallet: {
    balance: string;
  };
}
```

该结构来自项目的 `User` / `Wallet` 类型。

登录成功后：

1. 不把 Tianji token 返回浏览器。
2. 创建自己的随机 Session。
3. D1 保存加密后的 Tianji token 和手机号。
4. 浏览器只获得 HttpOnly Session Cookie。

---

# 7. Session 安全模型

Cookie：

`duoheshui_session=<random 32-byte base64url token>`

属性：

```text
HttpOnly
Secure
SameSite=Strict
Path=/
Max-Age=604800
```

D1 不保存 cookie 原文。

保存：

`SHA-256(sessionToken)`

作为：

`sid_hash`

这样数据库泄漏也不能直接重放 Session。

Tianji token、完整手机号、device_key 必须使用 Worker 自己的 AES-256-GCM key 加密后再写入 D1。

Worker Secret：

`APP_DATA_KEY`

必须使用 Cloudflare Secrets，而不是明文写进 `wrangler.jsonc`。Cloudflare 官方明确把 Secrets 用于 API key/token 等敏感值。

建议 encrypted-field 格式：

```text
v1.<iv-base64url>.<ciphertext-base64url>.<tag-base64url>
```

---

# 8. 查询余额

内部 API：

`GET /api/me`

只返回缓存数据：

```json
{
  "authenticated": true,
  "mobile": "*******8000",
  "balance": "12.34"
}
```

另外提供：

`POST /api/balance/refresh`

它实际访问 Tianji。

Android 原项目访问：

host：

`newxiaotian.tianji-inc.com`

path：

`/api/v1/UserInfoApi/getUserInfo`

plaintext 继续采用：

```json
{
  "mobile": "<mobile>",
  "type": "login"
}
```

DES encrypt。

outer header：

```json
{
  "act": "getUserInfo",
  "token": "<TIANJI TOKEN>"
}
```

服务器响应：

`response.data`

→ DES decrypt

→ JSON parse

→ 获取：

`wallet.balance`

Android 源码就是通过这一路径更新 balance。

成功后同步更新 Session 中缓存的 balance。

余额查询允许一次网络错误 retry，但最多一次。

---

# 9. 设备“绑定”的真实含义

这是本项目最重要的差异。

不要实现不存在的服务器 bind API。

原 Duoheshui 项目所谓 Devices 实际只是：

把二维码字符串分别保存为：

- `hot`
- `cold`

然后启动饮水时把对应二维码内容作为：

`device_key`

发给 IoT API。

因此 Web 产品中的“绑定设备”应该定义为：

> 将用户扫描/输入的二维码设备 key 与当前 Web Session 的 hot/cold 槽位建立关联。

不是向 Tianji 服务调用“设备绑定”。

如果将来确实需要官方账号层面的远端绑定，需要重新抓官方 App/小程序流量；当前 GitHub 项目没有提供相应接口依据。

---

# 10. 设备 API

## 查询

`GET /api/devices`

返回：

```json
{
  "hot": {
    "bound": true,
    "label": "热水",
    "fingerprint": "******AB12CD"
  },
  "cold": {
    "bound": true,
    "label": "冷水",
    "fingerprint": "******EF34GH"
  }
}
```

绝不把完整 `device_key` 再返回客户端。

## 保存

`PUT /api/devices/hot`

或：

`PUT /api/devices/cold`

body：

```json
{
  "deviceKey": "<QR RAW CONTENT>",
  "label": "宿舍热水"
}
```

保存前：

- trim。
- 允许较宽字符集。
- 最大长度建议 2048。
- 不把二维码内容写入 log。
- 使用 AES-GCM 加密写 D1。

## 删除

`DELETE /api/devices/hot`

`DELETE /api/devices/cold`

---

# 11. 原 Android 扫码 bug

原代码处理 hot QR 时：

先设置：

`hotDevice.value = result.contents`

但保存时却错误引用：

`coldDevice.value.text`

所以 Web 版本必须保存实际扫描结果：

```ts
saveDevice("hot", result.contents)
```

不要复制 Android bug。

---

# 12. 网页扫码

移动端网页支持：

1. Camera QR Scan。
2. 手工粘贴。
3. 图片识别作为可选功能。

推荐：

`@zxing/browser`

二维码解码必须在浏览器本地完成。

流程：

Camera → QR raw string → `/api/devices/hot|cold`

不要把 Camera 图像上传服务器。

---

# 13. 出水协议

内部 API：

`POST /api/water/hot/start`

和：

`POST /api/water/cold/start`

request：

```json
{
  "requestId": "<UUID>"
}
```

Worker：

1. 验证 Session。
2. 根据 hot/cold 从 D1 读取设备。
3. AES-GCM 解密 `device_key`。
4. 构造：

```json
{
  "device_key": "<QR CONTENT>"
}
```

5. DES encrypt。
6. 构造 gptechMsg。

header：

```json
{
  "act": "send",
  "token": "<TIANJI TOKEN>"
}
```

上游：

host：

`iot.tianji-inc.com`

path：

`/index.php/drinking/send_command/send`

原 Android 首页的 hot 和 cold 按钮都调用这一接口。

---

# 14. 出水响应

Android 代码：

1. 获取 JSON。
2. 获取 `data`。
3. DES decrypt。
4. 结果包含：

```json
{
  "order_sn": "..."
}
```

类型定义也明确存在 `order_sn`。

Web API 成功建议返回：

```json
{
  "ok": true,
  "started": true
}
```

不要把 `order_sn` 暴露到前端，除非调试模式明确需要。

注意：

源码还定义了：

```json
{
  "device_key": "...",
  "order_sn": "..."
}
```

对应 `enStartDrink()`。

但是当前 `HomePage` 并没有继续调用这个函数，而是 `send_command/send` 后就结束。

所以第一版：

**不要自行猜测第二个 start API。**

只复制已经实际被 HomePage 使用的调用链。

若实机测试发现只返回 `order_sn` 而设备不出水，再进行抓包确认第二阶段接口，不能凭函数名推测。

---

# 15. 防重复出水

这是物理设备控制，必须避免双击产生重复命令。

要求：

- 前端按下后立即 disable。
- requestId 使用 UUID。
- 后端保存短期 requestId。
- 同一个 requestId 只能执行一次。
- 同一账号 + 同一 hot/cold 建议 3 秒内最多 1 次。
- HTTP timeout 之后不能自动重试出水。
- 5xx 也不能自动 retry。
- 用户必须主动再次点击。

对于 HOT：

建议 UI 增加明确确认，例如：

`确认启动热水`

避免误触。

不要在 MVP 实现后台定时自动出热水。

---

# 16. D1 数据库

使用 Cloudflare D1。D1 可以直接通过 Worker binding 操作，是 serverless SQLite 型数据库。

migration：

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE sessions (
  sid_hash TEXT PRIMARY KEY,
  mobile_enc TEXT NOT NULL,
  upstream_token_enc TEXT NOT NULL,
  balance TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE devices (
  sid_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hot', 'cold')),
  label TEXT,
  device_key_enc TEXT NOT NULL,
  device_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (sid_hash, kind),

  FOREIGN KEY (sid_hash)
    REFERENCES sessions(sid_hash)
    ON DELETE CASCADE
);

CREATE TABLE command_requests (
  sid_hash TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,

  PRIMARY KEY (sid_hash, request_id)
);

CREATE INDEX idx_sessions_expires
ON sessions(expires_at);

CREATE INDEX idx_command_requests_created
ON command_requests(created_at);
```

定期在普通请求 opportunistically 清除：

- expired sessions
- 超过 10 分钟的 command_requests

无需 Cron MVP。

---

# 17. Server API

最终提供：

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

所有 response 统一：

成功：

```json
{
  "ok": true,
  "data": {}
}
```

失败：

```json
{
  "ok": false,
  "error": {
    "code": "UPSTREAM_UNAVAILABLE",
    "message": "服务暂时不可用"
  }
}
```

不要把上游原始 response、token、device_key 或异常 stack 返回浏览器。

---

# 18. HTTP 状态规范

使用：

- `400` 参数错误。
- `401` 未登录/session 过期。
- `403` Origin/CSRF/security policy。
- `404` device 未绑定。
- `409` 重复 command request。
- `429` rate limited。
- `502` Tianji API 返回无法解析的数据。
- `504` Tianji API timeout。

---

# 19. 上游 response parser

不要复制 Android 中：

```text
replace("\\", "").replace("\"", "")
```

这种脆弱处理。

改成：

1. `JSON.parse(responseText)`
2. 取 `data`
3. 如果 `data` 已经是正常 string，直接使用。
4. 如果发现其本身又是 JSON encoded string，再安全 parse 一次。
5. trim。
6. Base64 decode + DES decrypt。
7. JSON.parse decrypted plaintext。

任何一级失败：

抛：

`UpstreamProtocolError`

日志只记录：

- route
- HTTP status
- duration
- error category

不得记录 decrypted data。

---

# 20. Timeout

统一封装：

`fetchTianji()`

建议：

- sendCode：8 秒。
- loginByCode：10 秒。
- getUserInfo：8 秒。
- send water：8 秒。

仅：

`getUserInfo`

允许网络级一次 retry。

以下绝对不要自动 retry：

- sendCode
- water/start

避免重复短信和重复出水。

---

# 21. Origin HTTP 风险

原 GitHub 项目明确使用的是 HTTP endpoint，而不是 HTTPS。

实现时首先测试：

两个 Tianji host 是否已经支持 TLS。

优先级：

1. 如果 HTTPS endpoint 可以正常得到与 HTTP 相同响应，强制 HTTPS。
2. 如果只支持 HTTP，Worker 可以作为浏览器 HTTPS 与旧 Origin 之间的代理。
3. 但是必须在 README 中明确说明 Worker→Origin 最后一段是明文 HTTP。

不要让浏览器直接请求 HTTP Origin。

---

# 22. 前端 UI

移动优先。

页面：

## 未登录

Card：

“小天同学”

输入：

手机号

按钮：

`获取验证码`

验证码输入。

按钮：

`登录`

验证码发送后显示 60 秒倒计时。

---

## Dashboard

显示：

```text
账户
*******8000

余额
¥ 12.34

[刷新余额]
```

设备：

```text
热水设备
已绑定 ••••••AB12CD
[重新绑定]

冷水设备
已绑定 ••••••EF34GH
[重新绑定]
```

主控制区：

```text
[ 热 水 ]

[ 冷 水 ]
```

点击后显示：

`正在发送指令…`

成功：

`设备启动指令已发送`

错误：

`启动失败，请确认设备二维码及账户状态`

---

# 23. 前端绝不能保存的东西

禁止写入：

- localStorage
- sessionStorage
- IndexedDB

的内容：

- Tianji token
- 完整 device_key
- DES plaintext response
- 登录验证码

登录状态依赖 HttpOnly Cookie。

浏览器内存只保留当前 UI 所需数据。

---

# 24. 安全 headers

Worker 返回：

```text
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(self)
X-Frame-Options: DENY
```

CSP 至少限制：

```text
default-src 'self'
connect-src 'self'
img-src 'self' data: blob:
camera only self
frame-ancestors 'none'
```

如 Vite 构建要求调整 script/style CSP，应按照最终 bundle 设置，不要直接使用宽泛 `*`。

---

# 25. CSRF / Same-origin

API 不开启任意 CORS。

所有修改状态的 API：

POST / PUT / DELETE

验证：

`Origin`

必须与当前 Worker origin 相同。

前端增加：

```text
X-Duoheshui-Client: web
```

作为附加防护。

Cookie 使用 SameSite=Strict。

---

# 26. 日志保护

禁止：

```ts
console.log(token)
console.log(deviceKey)
console.log(phone)
console.log(gptechMsg)
console.log(decryptedPayload)
```

允许：

```json
{
  "event": "water_command",
  "kind": "hot",
  "success": true,
  "durationMs": 412
}
```

生产环境手机号只能显示 hash 或 last4。

---

# 27. Cloudflare 项目结构

建议：

```text
duoheshui-web/
├─ src/
│  ├─ app/
│  │  ├─ App.tsx
│  │  ├─ api.ts
│  │  ├─ pages/
│  │  ├─ components/
│  │  └─ qr/
│  │
│  └─ worker/
│     ├─ index.ts
│     ├─ routes/
│     │  ├─ auth.ts
│     │  ├─ balance.ts
│     │  ├─ devices.ts
│     │  └─ water.ts
│     │
│     ├─ upstream/
│     │  ├─ crypto.ts
│     │  ├─ protocol.ts
│     │  ├─ user-api.ts
│     │  └─ drinking-api.ts
│     │
│     ├─ session.ts
│     ├─ storage-crypto.ts
│     ├─ database.ts
│     ├─ security.ts
│     └─ errors.ts
│
├─ migrations/
│  └─ 0001_init.sql
│
├─ tests/
│  ├─ crypto.test.ts
│  ├─ protocol.test.ts
│  ├─ auth.test.ts
│  └─ water.test.ts
│
├─ wrangler.jsonc
├─ vite.config.ts
├─ package.json
└─ README.md
```

---

# 28. Cloudflare 配置

采用一个 Worker 同时运行：

- React SPA static assets。
- `/api/*` Worker。

Cloudflare 官方目前支持 Worker 与 Static Assets 一次部署，并支持 SPA fallback。

核心 `wrangler.jsonc` 形态：

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",

  "name": "duoheshui-web",

  "main": "./src/worker/index.ts",

  "compatibility_date": "2026-09-02",

  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": [
      "/api/*"
    ]
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "duoheshui",
      "database_id": "<CLOUDFLARE_D1_ID>"
    }
  ],

  "secrets": {
    "required": [
      "APP_DATA_KEY",
      "TIANJI_DES_KEY",
      "TIANJI_DES_IV"
    ]
  }
}
```

2026-08-04 之后 compatibility date 默认启用 Cloudflare 的新版 Node compatibility，因此无需为新项目额外添加 `nodejs_compat`。

运行：

```bash
npx wrangler types
```

不要手写 Worker Env 类型；Cloudflare 也推荐从 Wrangler 配置生成 bindings types。

---

# 29. Secrets

部署时创建：

```text
APP_DATA_KEY
TIANJI_DES_KEY
TIANJI_DES_IV
```

值：

`TIANJI_DES_KEY`

为 Android 协议兼容 key。

`TIANJI_DES_IV`

为 Android 协议兼容 IV。

虽然这两个值来自公开 GitHub 仓库，也不要把它们放入客户端代码。

`APP_DATA_KEY`

必须随机生成 32 bytes，用于 AES-256-GCM。

不要提交 `.dev.vars`。

---

# 30. 测试

必须分 4 级。

## A. Crypto unit test

使用上面提供的三个 DES 测试向量。

encrypt/decrypt 必须完全一致。

---

## B. Protocol test

Mock upstream。

确认：

```text
gptechMsg
```

经过一次 URL form encoding。

验证：

- act。
- token。
- msg_id。
- source_version。
- encrypted data。

---

## C. API integration test

测试：

1. send-code 正常。
2. 登录失败。
3. 登录成功。
4. session cookie。
5. refresh balance。
6. bind hot。
7. bind cold。
8. start hot。
9. start cold。
10. 未登录调用返回 401。
11. 无设备返回 404。
12. 重复 requestId 返回 409。
13. rate limit 返回 429。

所有 Tianji API 使用 Mock。

---

## D. Real-account smoke test

只在用户本人账号和本人有权使用的设备上执行。

顺序必须是：

1. 测试 sendCode。
2. 测试 login。
3. 验证 login decrypted payload。
4. 测试 balance。
5. 保存冷水 device_key。
6. 实机执行一次冷水。
7. 确认设备动作。
8. 再测试热水。

不要用热水作为第一次真实控制测试。

不要做批量设备扫描或其他账号测试。

---

# 31. 上线验收标准

必须同时满足：

### 登录

- 能发送短信。
- 正确验证码能登录。
- 错误验证码不会建立 Session。
- Tianji token 浏览器不可见。

### 余额

- 登录后显示余额。
- 刷新能调用 getUserInfo。
- 余额变化正确更新。

### Device

- 可手工输入二维码。
- 可 Camera Scan。
- hot/cold 不会互相覆盖。
- 页面刷新后设备仍存在。
- API 不返回完整 key。

### Control

- hot 对应 hot device。
- cold 对应 cold device。
- 一次点击只产生一次 upstream request。
- 出水 API 不自动 retry。
- 页面有 loading / success / error 状态。

### Security

浏览器 DevTools：

不得看到：

- upstream token。
- D1 encryption key。
- 完整持久化 device_key。
- DES decrypted user payload。

Cookie 必须 HttpOnly。

---

# 32. 对 Codex 的实现要求

请严格遵循以下原则：

1. 先实现测试，再实现 DES adapter。
2. 只有 crypto test vector 全部通过后才能写 Tianji API。
3. 不自行推测不存在的 upstream API。
4. 不复制 Android SharedPreferences 设计。
5. 不把 upstream token 放浏览器。
6. 不把完整 device_key 返回浏览器。
7. 不记录敏感日志。
8. 不自动 retry 出水。
9. 不自动 retry 发短信。
10. 不实现公共设备发现。
11. 不实现批量账号。
12. 不实现批量控制设备。
13. 不实现定时自动出水。
14. 所有接口仅针对用户本人登录账号和本人有权操作的饮水机。
15. 修正原 Android hot QR 保存错误。
16. `msg_id` 每次请求重新生成。
17. response parser 不允许简单删除所有反斜线或双引号。
18. 上游 HTTPS 若可用必须优先 HTTPS。
19. 如果上游只接受 HTTP，需要 README 明确标注。
20. 如果真实 API 返回格式与 GitHub 源码不同，停止猜测，保留 sanitized 原始结构供开发者分析。

---

# 33. 第一阶段实施顺序

Codex 按以下顺序实现：

Phase 1：

React + Worker + D1 基础项目。

Phase 2：

DES encrypt/decrypt + test vectors。

Phase 3：

gptechMsg builder + upstream client。

Phase 4：

sendCode/login。

Phase 5：

Session + encrypted D1 storage。

Phase 6：

balance refresh。

Phase 7：

device bind + QR scanner。

Phase 8：

cold/hot control。

Phase 9：

rate limiting + idempotency。

Phase 10：

security headers + CSP + log sanitization。

Phase 11：

Cloudflare deployment。

Phase 12：

真实账号 smoke test。

---

# 34. 重要现实限制

当前结论属于：

**协议源码层面确认可实现，线上兼容性需要真实账号进行最后验证。**

原因：

GitHub 项目给出了明确协议实现，但无法仅凭静态源码保证 Tianji 服务今天仍然完全接受这些旧字段和旧 DES 协议。

尤其需要验证：

- SMS endpoint 是否仍存活。
- HTTPS 是否已支持。
- token 生命周期。
- `getUserInfo` payload 是否仍要求 `type:"login"`。
- `send_command/send` 是否仍然会直接启动设备。
- 是否新增验证码/风控/签名机制。

如果真实联调时上述协议已经变化，不要暴力尝试接口。

此时正确处理是：

抓取用户本人官方客户端的一次正常登录、余额查询和设备控制流量，与上述协议做 diff，再更新 adapter。

---

# 35. 许可证与复用边界

当前 GitHub 根目录展示的文件列表没有看到 LICENSE 文件。

因此：

不要直接复制原 App UI、资源、图标或大段 Kotlin 源代码。

实现应只依据已经观察到的协议行为重新编写 TypeScript。

项目 README 中注明：

- 非官方客户端。
- 与“小天同学”官方服务无关联。
- 用户只能操作自己有权访问的账号及设备。
- 第三方服务接口变化可能导致功能失效。

---

# 最终架构

```text
                HTTPS
Mobile Browser ──────────────┐
                             │
                    Cloudflare Worker
                   ┌─────────┴──────────┐
                   │                    │
             React Static Assets     /api/*
                                        │
                    ┌───────────────────┼─────────────────────┐
                    │                   │                     │
                   D1              Secrets / AES          Rate Limit
                    │
                    │
              encrypted token
              encrypted mobile
              encrypted device_key
                    │
                    ▼
              Tianji Adapter
          DES-CBC / gptechMsg
             │             │
             ▼             ▼
       User/UserInfo       IoT
          Origin          Origin
             │             │
             ▼             ▼
       Login/Balance    Hot/Cold Start
```

Cloudflare Worker 必须成为 Tianji 协议和浏览器之间唯一的 trust boundary。

浏览器只看到本项目自己的 `/api/*`。