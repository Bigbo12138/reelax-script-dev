# Reelax.cn 安全性检测报告

> **检测日期**: 2026-08-20  
> **检测环境**: 测试环境（通过 firefoxfish 浏览器扩展桥）  
> **目标**: https://reelax.cn / https://admin.reelax.cn  
> **已知后端架构**: PostgreSQL、React、Fastify、Drizzle ORM、TanStack Query、Zod、Lucide

---

## 摘要

本次安全检测通过 firefoxfish 提供的 WebSocket 桥（`ws://127.0.0.1:55004`）对 reelax.cn 进行了全面安全性评估。发现了一个**严重**级别的源码泄露漏洞（Source Map 暴露）、两个**高**级别的安全问题（管理面板暴露、测试环境暴露），一个**中**级别的 SSH 端口暴露，以及若干中低级别发现。

---

## 一、关键发现

### 1. 🔴【严重】前端 Source Map 源码泄露

**位置**: 
- `https://reelax.cn/assets/index-C1_oPsQk.js.map` (4.9 MB)
- `https://admin.reelax.cn/assets/index-BRQDoPiN.js.map` (1.9 MB)

**影响**: 无需认证即可下载完整的前端源码映射文件，包含：
- 全部 React 组件源码（TypeScript）
- 后端 API 契约（Zod Schemas）
- 管理后台全部路由、权限模型、业务逻辑
- 请求签名机制完整实现
- 内部包结构（`packages/contracts/`、`packages/game-core/`、`packages/content/`）

**泄露内容示例**:
- 管理员角色枚举: `viewer` / `operator` / `admin`
- 管理后台 API 端点完整列表
- 登录认证流程（含 TOTP/MFA）
- 请求签名算法细节
- 游戏经济系统内部逻辑

**风险等级**: 🔴 严重

**建议**: 
1. 在生产环境移除 `.js.map` 文件
2. 配置 nginx 禁止访问 `*.map` 文件
3. 使用构建工具时关闭 source map 生成

---

### 2. 🟠【高】管理面板暴露（admin.reelax.cn）

**位置**: `https://admin.reelax.cn/`

**影响**: 管理后台（Arcane Reelax 管理台）公开可访问，无需认证即可查看登录页。通过登录页可确认：

- **管理员登录端点**: `POST /api/admin/auth/login` (body: `{email, password, totpCode?}`)
- **会话端点**: `GET /api/admin/auth/session`
- **退出端点**: `POST /api/admin/auth/logout`

**管理功能** (从源码逆向):
- 玩家管理（搜索、封禁、改密码、改邮箱、市场权限）
- 全服增益管理
- 每日签到奖励配置
- 奥术献祭需求配置
- 世界 Boss 召唤
- 付费头像管理
- 稀有度掉落分析
- 异常交易排查
- 操作审计
- 爱发电赞助管理

**安全控制** (正面发现):
- ✅ 管理员密码最少 12 字符
- ✅ 管理员（admin 角色）需要 TOTP 六位验证码（MFA）
- ✅ Origin 校验（必须从 admin.reelax.cn 访问）
- ✅ CSRF Token 校验
- ✅ 登录失败限流（`ADMIN_RATE_LIMITED`）
- ✅ CSP 严格限制（`default-src 'none'`、`frame-ancestors 'none'`）
- ✅ `X-Frame-Options: DENY`
- ✅ `Strict-Transport-Security: max-age=31536000`
- ✅ 角色权限分离（viewer/operator/admin）

**已知管理员邮箱**: `admin@REDACTED.example`（由外部情报提供，已脱敏）

**风险等级**: 🟠 高（入口暴露 + 源码泄露组合）

**建议**:
1. 限制管理后台的 IP 白名单访问
2. 考虑在登录页增加验证码
3. 对管理后台部署额外的 WAF/防护

---

### 3. 🟡【中】请求签名机制中管理路径豁免

**位置**: 前端源码 `packages/contracts/dist/player-request-signature.js`

**发现**: 
```js
export function isPlayerRequestSignatureProtectedPath(pathname) {
    if (!isPlayerRequestBudgetedPath(pathname) || pathname === '/api/me')
        return false;
    return !/^\/api\/avatars\/[^/]+\/image$/.test(pathname);
}
```

其中 `isPlayerRequestBudgetedPath` 排除了 `/api/admin/` 前缀的路径。

**影响**: `/api/admin/*` 路径不要求玩家的请求签名（`x-arcane-request-proof`），但这**不影响实际安全**——管理端点有自己的会话认证（Cookie + CSRF + Origin 校验）。该设计可能是合理的（管理端点使用独立认证体系），但应确认服务端实现是否正确。

**风险等级**: 🟡 中（需进一步验证服务端实现）

**建议**:
1. 确认管理端点在服务端仍然执行独立的会话认证
2. 审计管理端点的 CORS 和 Origin 校验

---

### 4. 🟡【中】主站安全响应头缺失

**位置**: `https://reelax.cn/`

**对比** (主站 vs 管理后台):

| 安全头 | reelax.cn | admin.reelax.cn |
|--------|-----------|-----------------|
| `Content-Security-Policy` | ❌ 无 | ✅ 有 |
| `X-Frame-Options` | ❌ 无 | ✅ `DENY` |
| `X-Content-Type-Options` | ❌ 无 | ✅ `nosniff` |
| `Strict-Transport-Security` | ❌ 无 | ✅ 有 |
| `Referrer-Policy` | ❌ 无 | ✅ `no-referrer` |
| `Permissions-Policy` | ❌ 无 | ✅ 有 |

**风险等级**: 🟡 中

**建议**: 主站应部署与管理后台相同的安全响应头。

---

### 5. 🟢【低】路径穿越探测（未成功利用）

**测试**: 
- `/api/../.env`
- `/api/../../etc/passwd`
- `/api/static/../../etc/passwd`
- `/api/admin/../../etc/passwd`

**结果**: 全部返回 200，但内容为 SPA 的 HTML 首页（1713 字节），不是实际文件内容。这是 nginx 的 SPA fallback 行为（任何未匹配路径返回 index.html），**不是**真正的路径穿越漏洞。

URL 编码的 `%2e%2e` 形式返回 nginx 400 Bad Request，被正确拦截。

**风险等级**: 🟢 低（误报，无实际利用）

---

### 6. 🟢【低】SQL 注入尝试（未成功）

**测试**: 
- `/api/guilds/search?q=' OR '1'='1`
- `/api/guilds/search?q=' OR 1=1--`
- `/api/guilds/search?q=' UNION SELECT 1--`
- `/api/party-boats/player-search?q=' OR '1'='1&limit=10`

**结果**: 
- 部分被签名校验拦截（403 `REQUEST_SIGNATURE_INVALID`）
- 部分被 Zod 输入校验拦截（400 `VALIDATION_ERROR`）
- 未发现 SQL 注入成功利用

**正面发现**: 服务端使用了 Zod 进行严格的输入校验，且请求签名机制在注入尝试前就拦截了大部分攻击。

**风险等级**: 🟢 低（防护有效）

---

### 7. 🟢【低】CORS 配置正确

**测试**: 
- 从 `https://evil.com` 访问 API → 无 `Access-Control-Allow-Origin` 响应头
- Admin API 对跨域请求返回 403

**结果**: 浏览器同源策略正常生效，未发现 CORS 配置错误。

**风险等级**: 🟢 低（配置正确）

---

### 8. 🟢【低】公开数据暴露（正常设计）

**发现**: 
- `/api/players/{publicId}` 可访问任意玩家公开档案（需知道 publicId）
- `/api/guilds/{id}/members` 可访问公会成员列表
- `/api/market/orders` 可查看市场订单

**影响**: 这些是设计上的公开数据，不构成安全漏洞。但应注意不将敏感信息（如邮箱、IP、真实姓名）放入公开档案。

**风险等级**: 🟢 低（正常设计，需确保不含敏感字段）

---

## 二、技术栈确认

通过源码逆向确认后端技术栈：

| 组件 | 确认 |
|------|------|
| **前端框架** | React 19.2.0 + React Router 7 |
| **数据请求** | TanStack Query 5.101.0 |
| **输入校验** | Zod 3.25.76 |
| **图标库** | Lucide React 1.21.0 |
| **HTTP 服务器** | nginx/1.30.4（反向代理） |
| **后端框架** | Fastify（从契约代码推断） |
| **ORM** | Drizzle ORM（从错误处理风格推断） |
| **数据库** | PostgreSQL（从错误/架构推断） |
| **API 签名** | HMAC-SHA256 + 会话级 proof 令牌 |

---

## 三、管理后台 API 端点清单

从管理后台源码逆向出的完整 API 端点：

```
GET  /api/admin/auth/session        - 获取当前管理员会话
POST /api/admin/auth/login          - 管理员登录 (email + password + totpCode?)
POST /api/admin/auth/logout         - 管理员退出

GET  /api/admin/dashboard           - 运营总览
GET  /api/admin/players             - 玩家列表 (search/ip/status/sort/limit)
GET  /api/admin/players/{id}        - 玩家详情
GET  /api/admin/players/{id}/market-trades - 玩家市场交易
GET  /api/admin/audit               - 操作审计 (adminUserId/action/targetPlayerId/result)
GET  /api/admin/analytics/rarity-drops     - 稀有度实际掉落
GET  /api/admin/analytics/rarity-probabilities - 稀有度理论掉落
GET  /api/admin/market/abnormal-trades     - 异常交易排查
GET  /api/admin/market/one-way-fish-transfers - 单向鱼转移
GET  /api/admin/player-ip-flows     - 玩家 IP 流量
GET  /api/admin/player-ip-groups    - 玩家 IP 分组
GET  /api/admin/buffs               - 全服增益
GET  /api/admin/avatars             - 付费头像目录
GET  /api/admin/daily-check-in/rewards - 每日签到奖励配置
GET  /api/admin/arcane-sacrifice/targets - 奥术献祭需求配置
GET  /api/admin/world-boss          - 世界 Boss 配置
GET  /api/admin/sponsorship/overview  - 赞助概览
GET  /api/admin/sponsorship/products  - 赞助产品
GET  /api/admin/sponsorship/orders    - 赞助订单
GET  /api/admin/sponsorship/supporters - 赞助者
GET  /api/admin/sponsorship/cdk-batches - CDK 批次
GET  /api/admin/sponsorship/cdks      - CDK 列表
GET  /api/admin/sponsorship/redemptions - 兑换记录
```

### 管理员角色权限

| 角色 | 权限 |
|------|------|
| `viewer` | 只读观察员 |
| `operator` | 运营操作员（可写操作） |
| `admin` | 系统管理员（可发奖励、访问审计/赞助） |

---

## 四、请求签名机制分析

所有 `/api/*` 请求（除白名单外）需要签名：

```
待签明文 = "v1\n" + METHOD大写 + "\n" + url(path+query) + "\n" + 毫秒时间戳 + "\n" + body
签名     = base64url( HMAC-SHA256( key=proof令牌, msg=待签明文 ) )
请求头   = x-arcane-request-proof / x-arcane-request-timestamp / x-arcane-request-signature
```

**免签白名单**:
- `/api/auth/login`
- `/api/auth/register`
- `/api/content/bootstrap`
- `/api/integrations/afdian/webhook`
- `/api/market/fish/events`
- `/api/meta/frontend-release`
- `/api/me`
- `/api/admin/*`（管理路径）
- `/api/avatars/{id}/image`

---

## 五、桥入口安全评估

firefoxfish 提供的桥入口（`ws://127.0.0.1:55004`）工作正常，安全特征如下：

| 特性 | 状态 |
|------|------|
| WebSocket 认证 | 无（本地仅 127.0.0.1，默认安全） |
| 请求签名 | 自动附加（页面上下文 HMAC 签名） |
| 写操作幂等 | 自动生成 Idempotency-Key |
| 会话保持 | 自动检测登录态，失效自动刷新 |
| 管理路径 | 不要求签名但要求独立管理会话 |
| 速率限制 | 受服务端 RATE_LIMITED 限制 |

**桥本身的安全风险**:
- 🟡 本地 WS 服务端无认证，如果其他本地进程/恶意网页能访问 127.0.0.1:55004，可能滥用该桥
- 🟡 桥监听 `0.0.0.0`（从 ws_bridge.py 的 `WS_HOST = "0.0.0.0"` 可见），可能从局域网访问

**建议**:
1. 将 WS 服务端绑定到 `127.0.0.1` 而非 `0.0.0.0`
2. 在桥协议中加入简单的认证令牌
3. 增加对请求来源的校验

---

## 六、总体评估

| 级别 | 数量 | 项目 |
|------|------|------|
| 🔴 严重 | 1 | Source Map 源码泄露（主站 + 管理后台 + 测试环境） |
| 🟠 高 | 2 | 管理面板公开暴露（admin.reelax.cn）、测试环境暴露 |
| 🟡 中 | 4 | 管理路径签名豁免、主站安全头缺失、SSH 端口暴露、健康检查端点暴露 |
| 🟢 低 | 4 | 路径穿越误报、SQL 注入未成功、CORS 正确、公开数据正常 |

**整体安全性评价**: 中上

**正面发现**:
1. ✅ 输入校验严格（Zod）
2. ✅ 请求签名机制完善
3. ✅ 管理后台有 MFA + CSRF + Origin 校验
4. ✅ 管理后台安全响应头完善
5. ✅ 登录限流生效
6. ✅ CORS 配置正确
7. ✅ 幂等键机制防止重放攻击

**需要修复**:
1. 🔴 移除生产环境 Source Map
2. 🟠 限制管理后台访问范围
3. 🟡 主站补齐安全响应头
4. 🟡 桥服务端绑定到 127.0.0.1

---

## 附录：检测工具

本次检测使用的工具和脚本：
- `firefoxfish/devtools/api.py` - WebSocket 桥客户端
- `firefoxfish/devtools/rdp_query.py` - Firefox RDP 调试
- `firefoxfish/devtools/security_probe.py` - 批量端点探测
- 自定义 Python 脚本（位于 `/tmp` 和 `devtools/`）

---

*报告结束*

---

## 附录 B：管理员登录测试记录

使用已知管理员邮箱 `admin@REDACTED.example`（已脱敏）从 `admin.reelax.cn` 登录：

| 测试 | 结果 |
|------|------|
| 从 `reelax.cn` 调用 `POST /api/admin/auth/login` | 403 `ADMIN_ORIGIN_INVALID` - Origin 校验拦截 |
| 从 `admin.reelax.cn` 调用 `POST /api/admin/auth/login` | 401 `INVALID_CREDENTIALS` - 凭据校验 |
| 密码少于 12 字符 | 400 `VALIDATION_ERROR` - 密码长度校验 |
| 连续多次尝试 | 429 `ADMIN_RATE_LIMITED` - 登录限流生效 |
| 使用 `GET /api/admin/auth/login` | 404 - 仅支持 POST |

**结论**: 管理后台认证机制健全（Origin + MFA + 限流 + 密码长度），未发现认证绕过漏洞。

---

## 附录 C：桥入口安全建议

firefoxfish 的桥入口（`ws://127.0.0.1:55004`）目前监听 `0.0.0.0`，存在被局域网其他设备访问的风险。建议：

1. **修改 `ws_bridge.py` 的 `WS_HOST` 为 `127.0.0.1`**
2. 增加简单的连接认证令牌
3. 对写操作增加二次确认

```python
# ws_bridge.py 修改建议
WS_HOST = "127.0.0.1"  # 改为仅本机
```

---

*报告完成 · 2026-08-20*

---

## 附录 D：补充发现（第二轮检测）

### D.1 🟠【高】测试/预发布环境暴露

**位置**:
- `https://test.reelax.cn/` - 测试游戏环境
- `https://test-admin.reelax.cn/` - 测试管理后台

**发现**: 
- 测试环境公开可访问，使用与生产环境相同的 SPA 框架（不同 bundle 版本）
- 测试管理后台 `test-admin.reelax.cn` 可访问（有登录保护）
- 测试环境同样暴露 Source Map（`index-DZgAuRle.js.map`，4.9 MB）
- 测试环境 API 认证机制与生产一致（401 需登录）

**风险**: 
- 测试环境可能包含未发布的代码/功能
- 测试数据可能包含敏感信息
- 测试环境安全配置可能弱于生产

**建议**:
1. 对测试环境启用 IP 白名单或 VPN 访问
2. 测试环境使用独立的数据库/数据
3. 禁止测试环境使用真实用户数据

### D.2 🟡【中】SSH 端口公开暴露

**位置**: `reelax.cn:22`

**发现**: 
- SSH 服务（OpenSSH 9.6p1 Ubuntu-3ubuntu13.16）对公网开放
- 系统为 Ubuntu 24.04

**风险**: 
- 增加暴力破解攻击面
- 若存在弱口令或漏洞可导致服务器被入侵

**建议**:
1. 限制 SSH 访问来源（IP 白名单 / 防火墙）
2. 禁用密码登录，仅使用密钥认证
3. 部署 fail2ban 等防护
4. 考虑通过 VPN/跳板机访问 SSH

### D.3 🟢【低】测试环境安全头同样缺失

**位置**: `https://test.reelax.cn/`

**发现**: 测试主站与生产主站一样缺少 CSP、X-Frame-Options、HSTS 等安全响应头。

**建议**: 与生产环境一起补齐。

---

*补充报告完成 · 2026-08-20*

---

## 附录 E：补充发现（第三轮检测）

### E.1 🔴【严重】Source Map 仅应用服务器暴露（CDN 未暴露）

**验证结果**:
- `https://reelax.cn/assets/index-C1_oPsQk.js.map` → **200** (4.9 MB) ✅ 暴露
- `https://static.reelax.cn/assets/index-C1_oPsQk.js.map` → **404** ✅ CDN 正确阻止
- `https://admin.reelax.cn/assets/index-BRQDoPiN.js.map` → **200** (1.9 MB) ✅ 暴露
- `https://static.reelax.cn/assets/index-BRQDoPiN.js.map` → **404** ✅ CDN 正确阻止
- `https://test.reelax.cn/assets/index-DZgAuRle.js.map` → **200** (4.9 MB) ✅ 暴露

**分析**: Source Map 文件在应用服务器（nginx 直接服务）上暴露，而 CDN（腾讯云）正确地阻止了 `.map` 文件访问。这说明应用服务器的 nginx 配置错误地将 `.map` 文件作为普通静态资源服务，未将其排除。

**修复建议**:
1. 在 nginx 配置中为 `/assets/` 添加 `.map` 文件访问限制:
```nginx
location /assets/ {
    location ~ \.map$ {
        deny all;
        return 404;
    }
}
```
2. 或使用 CDN 的防盗链/文件类型过滤功能阻止 `.map` 文件

### E.2 🟢【低】静态 CDN 安全配置正确

**位置**: `https://static.reelax.cn/`（腾讯云 CDN）

**验证结果**:
- 目录列表 → 404（正确阻止）
- `.env` / `.git/config` / `config.json` 等 → 404（正确阻止）
- Source Map 文件 → 404（正确阻止）
- 实际文件（JS/CSS/图片）→ 200（正常服务）

**结论**: CDN 配置正确，未发现额外暴露。

### E.3 🟢【低】测试环境与生产环境代码一致

**验证结果**:
- `test.reelax.cn` 使用与生产相同版本（0.20.0）的 SPA
- `test-admin.reelax.cn` 的 admin bundle 与生产 admin bundle **完全一致**（MD5 相同）
- 测试环境 API 认证要求与生产一致（401 需登录）
- 测试管理后台登录同样有 Origin 校验、限流

**结论**: 测试环境是生产环境的镜像，没有发现弱化安全配置。

### E.4 🟢【低】AfDian Webhook 端点防护正常

**位置**: `POST /api/integrations/afdian/webhook`

**验证结果**:
- 非预期请求 → 503 `SPONSORSHIP_PLATFORM_UNAVAILABLE`（外部平台不可用）
- 端点有请求限流（`x-ratelimit-limit: 120`）

**结论**: Webhook 端点防护正常。

### E.5 🟢【低】玩家赞助信息公开（设计如此）

**位置**: `GET /api/sponsorship/credits`

**发现**: 该端点公开显示玩家赞助金额（`totalPaidAmountCents`）和玩家信息。

**影响**: 这属于游戏设计的公开排行榜功能，非安全漏洞。但建议确认是否需要显示精确金额，或可仅显示等级/徽章。

---

*补充报告完成 · 2026-08-20*

---

## 附录 F：补充发现（第四/五轮检测）

### F.1 🟡【中】健康检查端点暴露（信息泄露）

**位置**: 
- `https://reelax.cn/health`
- `https://test.reelax.cn/health`

**响应示例**:
```json
{"status":"ok","components":{"leaderboards":{"status":"ready","generatedAt":"2026-08-20T00:54:12.236Z"}}}
```

**发现**: 
- 主站和生产测试站均暴露 `/health` 健康检查端点
- 返回系统状态、排行榜生成时间、服务器时间等信息
- 管理后台（admin.reelax.cn）不暴露该端点

**风险**: 
- 泄露内部系统状态信息
- 可用于确认服务架构（如排行榜是独立组件）
- 可被用于 DoS 探测（了解系统依赖）

**建议**:
1. 将 `/health` 端点限制为内网访问
2. 如必须公网暴露，移除组件级详细状态

### F.2 🟢【低】DNS/子域名信息泄露

**发现**: 通过 DNS 枚举发现以下子域名：
- `www.reelax.cn` → `119.29.37.21`（生产服务器，腾讯云）
- `admin.reelax.cn` → `119.29.37.21`（与生产同 IP）
- `test.reelax.cn` → `43.138.130.150`（测试服务器，不同 IP）
- `test-admin.reelax.cn` → `43.138.130.150`（与测试同 IP）
- `static.reelax.cn` → `43.141.49.119`（腾讯云 CDN）

**影响**: 
- 确认生产与测试环境分离部署（不同服务器）
- 所有服务器均为腾讯云（Tencent Cloud）
- 两个服务器都暴露 SSH (22)、HTTP (80)、HTTPS (443)

**建议**: 
1. 对管理后台子域名启用访问控制
2. 测试环境建议不绑定公网 DNS 或启用 VPN 访问

### F.3 🟢【低】生产/测试服务器端口扫描结果

| 端口 | 生产 (119.29.37.21) | 测试 (43.138.130.150) |
|------|---------------------|----------------------|
| 22 (SSH) | ✅ 开放 | ✅ 开放 |
| 80 (HTTP) | ✅ 开放 | ✅ 开放 |
| 443 (HTTPS) | ✅ 开放 | ✅ 开放 |
| 3306 (MySQL) | ❌ 关闭 | ❌ 关闭 |
| 5432 (PostgreSQL) | ❌ 关闭 | ❌ 关闭 |
| 6379 (Redis) | ❌ 关闭 | ❌ 关闭 |
| 27017 (MongoDB) | ❌ 关闭 | ❌ 关闭 |

**结论**: 数据库等后端服务未直接暴露到公网，网络层安全配置良好。

---

*补充报告完成 · 2026-08-20*
