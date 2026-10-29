# Reelax 助手（Chrome / Edge 扩展）

浏览器启动时自动打开 [reelax.cn](https://reelax.cn/)，并向该站点注入可配置的 JS 脚本（等价油猴 `@grant none`，可直接读 `window.arcaneReelax`）。**Chrome/Edge Manifest V3** 版本：后台为单一 Service Worker，`browser.*` 经 `chrome-polyfill.js` 桥接为 `chrome.*`。

> 当前版本 **v1.14.9** · 更新记录见 [`CHANGELOG.md`](./CHANGELOG.md) · 进阶开发与运维说明见 [`SKILL.md`](./SKILL.md) · GitBook 风格使用文档见 [Wiki](https://github.com/Bigbo12138/reelax-script-dev/wiki)

下载安装包：[Releases](https://github.com/Bigbo12138/reelax-script-dev/releases)（每次打 `v*` tag 由 GitHub Actions 自动构建 zip）

---

## 目录

- [功能一览](#功能一览)
- [安装](#安装)
- [快速上手](#快速上手)
- [设置项](#设置项)
- [工具栏弹窗](#工具栏弹窗)
- [脚本清单](#脚本清单)
- [文件结构](#文件结构)
- [Python 桥](#python-桥bridgejs--apipy)
- [运维脚本（devtools / market / gaming）](#运维脚本devtools--market--gaming)
- [版本与发布](#版本与发布)
- [说明与限制](#说明与限制)

---

## 功能一览

### 自动化（后台 `monitor.js` + 页面 `聚合.js`）

| 能力 | 说明 |
|---|---|
| **开机自动打开** | 浏览器启动自动打开目标站点（可关） |
| **脚本注入** | 把 `scripts/` 下的 JS（或自定义代码）注入 reelax.cn 主世界 |
| **自动补满杆数** | 以服务端时间精确调度为主（`snapshot.fishing` → `game.fishing.refill()`），DOM 兜底节流 30s；仅当剩余严格低于一半才真正请求 |
| **自动切图** | 优先级：赛事 > 跟随船 > 金风 > 经验 > 天气 > 奥术涌动；船长/舵手自动整船 `party.travelTo()` 开船并持续跟随船长 |
| **自动换饵** | 按收益切换最优饵；顶级饵策略可配 |
| **每日签到** | 优先官方 API，DOM 兜底 |
| **自动出售库存** | 定时切库存页出售鱼与低品级装备（品级多选、保留上限、可通知） |
| **自动加点 / 加专精** | 检测 `unspentStatPoints > 0` 自动全加（目标属性可配，支持「主属性达阈值后转副属性」）；每 10 分钟把当前图专精点全投 |
| **保底监控** | 定时签名查 `/api/statistics` 的 pity 字段（奥秘/奇异出货、软保底满、逼近硬保底）；`pity-trigger` 可在奥秘涌流窗口记录「全加运气」硬保底基准，满保底自动洗点全加运气 |
| **自动开公会增益** | 由「优选地图」通知驱动，按赛程/天气剩余时长折算份数，防多开 |
| **自动献祭** | 按资源（遗物/鱼/金币）各自的**门槛百分比**自动捐献；门槛设为 `0` 表示该资源完全不参与 |
| **世界 Boss** | 自动选 Boss 属性、开战前后洗点（可选「全投属性」按实际伤害择优）、开战后补杆 |
| **公会税率时段自动化** | 按北京时间时段自动填写并保存公会税率 |
| **掉线 / 登录失效监控** | webRequest 心跳 + proof 主动验证，掉线/失效自动刷新页面并统一通知 |
| **通知** | 企业微信 webhook / 飞书自建应用；日报可定时推送 |

### 市场（`一键市场.js` / `market_events.js`）

- **批量挂单**：渔获页按品级、单鱼数量下限、市场最低卖价 ± 金额批量挂单；已有挂单先下架再合并重挂；达活动上限自动停止。
- **捡漏页签**：按稀有度列出市场最低价鱼（升序）、点击跳转；按地图过滤（仅看所选图）、仅看专精鱼；专精等级本地缓存秒读。
- **价格检测**：一键扫非最低价卖单并下架；扫非最高价求购单并下架；支持**全选**一键勾选重挂，挂单成功项自动取消勾选。
- **可议价提示**：检测到「我的价已是最优第一名」且市场第一二档断层 `(M1−M2)/M2` 达到**按挂价分档**阈值（`<1k=5%`、`1k~1w=3%`、`1w~10w=2%`、`10w~100w=1.5%`、`100w~1000w=1%`、`>=1000w=0.5%`）时，列入可议价区块，勾选后按建议价一键重挂（卖方向 = M2−1、买方向 = M2+1，重挂后仍保持第一名）。
- **实时行情采集**：订阅市场 SSE（order-book / listing-created），经 postMessage → 桥转发给外部大屏。

### 辅助显示（注入脚本）

装备初始价显示、装备属性占比、以物易物价格、交换填单助手、保底显示、日报采集、日志收集等，详见[脚本清单](#脚本清单)。

---

## 安装

### 方式一：解压 Release 包（推荐）

1. 到 [Releases](https://github.com/Bigbo12138/reelax-script-dev/releases) 下载最新 `reelax-script-dev-v*.zip` 并解压。
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），右上角开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择含 `manifest.json` 的目录（zip 解压出的 `reelax-script-dev-vX.Y.Z/` 子目录）。
4. 生效后把扩展**固定到工具栏**。

### 方式二：仓库根目录直接加载

同上，第 3 步直接选择本仓库根目录。

> ⚠️ 临时加载的扩展在浏览器**完全退出**后不会自动加载，重启需重新加载。
> 改 `manifest.json` / 后台脚本后点扩展页「重新加载」；仅改注入脚本时刷新目标页面即可（`web_accessible_resources` 已放行 `scripts/*`）。

---

## 快速上手

1. 安装后点工具栏图标 → **打开设置**。
2. 确认 **目标 URL**（默认 `https://reelax.cn/`）、**开机自动打开**。
3. **注入脚本**列表：默认启用 `日志收集.js`、`自动登录.js`、`聚合.js`、`自动补满次数.js`、`自动加点.js`、`保底显示.js`、`一键市场.js`、`装备属性占比.js`、`交换填单助手.js`；`自动出售库存.js` 默认关闭。
4. 需要通知时填 **企业微信 webhook**（或开启飞书）并点「测试通知」。
5. 打开游戏页面，页面右下角出现聚合脚本控制面板即为注入成功。

---

## 设置项

配置保存在 `storage.local`，设置页改动即时热更新。新增配置项须同步 `options.js` 的 `DEFAULTS`。

### 基础

| 键 | 默认 | 说明 |
|---|---|---|
| `targetUrl` | `https://reelax.cn/` | 目标站点 |
| `autoOpenOnStartup` | `true` | 浏览器启动自动打开 |
| `enabledScripts` | 见上 | 启用的注入脚本列表 |
| `customCode` | `''` | 自定义注入代码 |
| `autoRefreshMin` | `0` | 定时刷新页面（0 关闭） |
| `bridgePort` | `55004` | 本机 Python 桥 WebSocket 端口 |
| `loginCheckMin` | `5` | 登录保活检查间隔（分钟） |

### 监控（`monitor.js`）

| 键 | 默认 | 说明 |
|---|---|---|
| `monitorEnabled` | `true` | 后台监控总开关 |
| `offlineCheckMin` | `2` | 掉线检测间隔（分钟） |
| `proofCheckSec` | `30` | proof 主动验证间隔（秒） |
| `reloadCooldownSec` | `60` | 自动刷新冷却（秒） |
| `webhookUrl` | `''` | 企业微信 webhook URL（可由 `run.sh` 环境变量注入） |
| `feishuEnabled` / `feishuAppId` / `feishuAppSecret` | `false` / `''` / `''` | 飞书自建应用通知 |
| `feishuReceiveIdType` / `feishuReceiveId` | `open_id` / `''` | 飞书接收者 |
| `dailyReportWebhook` | `false` | 日报推送到 webhook |
| `dailyReportTimes` | `''` | 日报推送时刻（北京时间，逗号分隔，如 `09:30,18:30`） |

### 加点 / 专精

| 键 | 默认 | 说明 |
|---|---|---|
| `autoAllocate` | `true` | 自动加点总开关 |
| `statTarget` | `luck` | 目标属性（`strength`/`intelligence`/`luck`/`endurance`） |
| `primaryTotalTarget` | `0` | 主属性总属性阈值，达标后剩余点转副属性（0 = 不启用） |
| `allocSecondary` | `luck` | 副属性 |
| `autoMastery` | `false` | 定时把当前图专精点全投 |

### 保底 / 洗点

| 键 | 默认 | 说明 |
|---|---|---|
| `pityMonitor` | `true` | 保底监控 |
| `pityCheckSec` | `300` | 保底查询间隔（秒） |
| `pityHardMargin` | `1000` | 距硬保底多少杆内触发提醒 |
| `pityTriggerArcane` / `pityTriggerExotic` | `false` | 奥秘 / 奇异满软保底时自动洗点全加运气 |
| `pityTriggerSurgeOnly` | `false` | 仅在奥术涌动窗口内触发 |
| `pityTriggerTopBait` | `false` | 触发前确认已用顶级饵 |

### 出售 / 献祭

| 键 | 默认 | 说明 |
|---|---|---|
| `fishAutoSell` | `true` | 自动出售鱼 |
| `fishSellRarities` | `['uncommon']` | 出售品级 |
| `fishKeepMax` | `20000` | 每种鱼保留上限 |
| `fishSellCheckSec` | `600` | 出售检查间隔（秒） |
| `gearAutoSell` | `true` | 自动出售低品级装备 |
| `gearSellRarities` | `common…epic` | 出售品级 |
| `gearSellNotify` | `true` | 出售后通知 |
| `sacrificeAuto` | `true` | 自动献祭 |
| `sacrificeServerPct` | `60` | 服务端目标百分比 |
| `sacrificeRelicPct` / `sacrificeFishPct` / `sacrificeGoldPct` | `0.5` | 各资源参与门槛（% of target）；**设为 0 = 该资源不参与** |
| `sacrificeFishRarities` | `['uncommon']` | 献祭鱼品级 |

### 增益 / Boss / 装备监测

| 键 | 默认 | 说明 |
|---|---|---|
| `guildBoostAuto` | `true` | 自动开公会增益 |
| `worldBossAuto` | `true` | 世界 Boss 自动处理 |
| `worldBossRespec` | `false` | Boss 战前洗点全投（战后恢复） |
| `worldBossRespecStats` | 全部 4 项 | 全洗时参与择优的属性集合 |
| `gearWatchEnabled` | `false` | 市场装备监测 |
| `gearWatchRules` | 1 条模板 | 监测规则（品级/部位/最低品质/最低强化/最高价） |
| `gearWatchCheckSec` | `600` | 监测间隔（秒） |
| `gearWatchNotify` | `true` | 命中后 webhook 通知 |

---

## 工具栏弹窗

- 一键打开目标站 / 打开设置
- 桥状态（连接 / 登录态 / proof）
- 游戏状态实时数据、奥秘·奇异保底进度
- 自动开增益面板

---

## 脚本清单

| 脚本 | 作用 |
|---|---|
| `聚合.js` | **主脚本**：自动切图 + 补满 + 换饵 + 签到 + 公会税率时段 + 优选地图通知 + 页面控制面板 |
| `一键市场.js` | 批量挂单 / 捡漏 / 价格检测 / 可议价重挂 |
| `保底显示.js` | 保底进度浮层；商店 buff 按启用天气购买 |
| `自动补满次数.js` | 页面侧补杆（与 monitor 协同） |
| `自动出售库存.js` | 库存页自动出售 |
| `自动加点.js` | 页面侧加点辅助（逻辑主体在 `monitor.js`） |
| `自动登录.js` | 读取 `window.__REELAX_LOGIN__` 自动登录 |
| `交换填单助手.js` | 以物易物填单辅助 |
| `以物易物价格.js` | barter 价格 / 硬通货鱼表显示 |
| `装备初始价显示.js` | 装备基础价对照显示 |
| `装备属性占比.js` | 装备属性占比浮层 |
| `日报采集.js` | 汇总当日累计杆数 / 净赚 |
| `日志收集.js` | 页面日志收集上报 |
| `market_events.js` | 市场 SSE 行情采集汇总（非注入类，供桥使用） |
| `sync-hook.js` | `document_start` 主世界同步采集钩子（写 sessionStorage + postMessage） |

---

## 文件结构

```
manifest.json            # 扩展清单（MV3，Service Worker）
background-boot.js       # MV3 入口：importScripts 按序载入后台脚本
background.js            # 自动开页 + 注入 + 自动刷新 + 日志落盘
chrome-polyfill.js       # browser.* → chrome.*（Promise 版）桥接
injector.js              # 注入 userscript + postMessage 双向通道
domclick.js              # 页面上下文签名与点击执行
api.js                   # 签名请求库（getProof / sign / signedFetch）
bridge.js                # Python 桥（WS 客户端，55004）
monitor.js               # 后台监控主体（加点/专精/保底/献祭/增益/Boss/日报/通知）
popup.html / popup.js    # 工具栏弹窗
options.html / options.js# 设置页
run.sh                   # 本地启动 / 参数化运行入口
scripts/                 # 注入脚本（见脚本清单）
devtools/                # 纯标准库 Python 工具（签名、桥、RDP、市场、采集）
market/                  # 量化交易框架（barter / 鱼市 / 装备提醒）
gaming/                  # 账号运营脚本（检查、开箱、专精扫货、装备扫货）
api/                     # API 逆向文档与收益分析
data/                    # 日报数据快照
docs/                    # 安全审计报告与探测结果
.github/workflows/       # Release 自动构建
```

---

## Python 桥（bridge.js ↔ api.py）

扩展后台 `bridge.js` 作为 **WebSocket 客户端**连接本机 `ws://127.0.0.1:55004`（服务端为 `devtools/ws_bridge.py`，断线自动重连 + 15s 心跳）；接收 Python 下发任务，在**页面上下文签名**请求 reelax.cn 并回传结果。修改协议需 `bridge.js` 与 `ws_bridge.py` 两侧同步。

```bash
python3 devtools/api.py serve                                   # 常驻桥
python3 devtools/api.py me                                      # 单次：登录态 / proof
python3 devtools/api.py market-orders --side sell --limit 10    # 市场挂单查询
python3 devtools/api.py raw "/api/mastery"                      # 任意签名路径
```

> 登录 cookie 是 **HttpOnly**（`document.cookie` 为空），脱离浏览器拿不到会话，必须走桥或 RDP。所有 `/api/*` 请求都需短时请求签名（见 `SKILL.md` §2.5）。

---

## 运维脚本（devtools / market / gaming）

| 目录 | 用途 |
|---|---|
| `devtools/` | `api.py`（CLI 桥）、`ws_bridge.py`（WS 服务端）、`rdp_query.py`、`market.py`、`guild_stats.py`、`collect_fish.py`、`sign.js`、安全探测 `test_*.py`、大屏页面等 |
| `market/` | 量化交易框架：`pricing.py` 定价、`barter_scanner.py` 以物易物扫描、`fish_market.py` 鱼市、`executor.py` 执行、`alerts.py` 统一告警、`store.py` 持久化。设计文档见 `market/量化交易框架设计.md` |
| `gaming/` | 账号运营：`check.py` 一键状态检查、`open_chests.py` 开箱、`shop_mastery.py` 专精扫货、`shop_gear.py` 装备扫货。运营手册见 `gaming/PLAYBOOK.md` |
| `api/` | `api.md` / `domclick.md` 接口逆向文档、`fish_economy.py` / `history_economy.py` / `gear_advisor.py` 收益分析 |

---

## 版本与发布

- 版本号规则：破坏性修改 → **MAJOR+1**（低位清零）；向下兼容新功能 → **MINOR+1**；向下兼容 Bug 修复 / 优化 → **PATCH+1**。
- 发布步骤：改 `manifest.json` 版本 + `CHANGELOG.md` 插入条目 → 提交为 `vX.Y.Z: 描述` → 打轻量 tag `vX.Y.Z` → push `main` 与 tag。
- 推送 tag 后 `.github/workflows/release.yml` 自动：校验 `manifest.json` 版本与 tag 一致 → `git archive` 导出 → 打 zip → 发布到 Releases。

---

## 说明与限制

- **配置持久化**：所有可调项存 `storage.local`，设置页即改即热更新；新增配置项前请确认 `options.js` 的 `DEFAULTS` 已包含。
- **注入时机**：`sync-hook.js` 在 `document_start`（主世界），其余注入脚本在 `document_idle`，均可直读页面 DOM 与全局变量。
- **请求签名**：登录后的直接 `/api/*` 请求受短时签名 + 会话级频率预算限制；优先用 `window.arcaneReelax` 内置 API（零 HTTP），避免粗暴轮询。
- **补满红线**：不要用合成点击补满按钮（`.click()`），按钮只响应 `isTrusted` 事件；统一用 `game.fishing.refill()`。
- **自动登录凭据**：`run.sh --login <邮箱> <密码>` 或环境变量 `FISH_EMAIL` / `FISH_PASSWD`，生成运行期 `scripts/login_credentials.js`（`window.__REELAX_LOGIN__`）；该文件已被 `.gitignore` 忽略，不进版本库。
- **文件编码**：仓库内 JS/JSON 使用 **UTF-8 无 BOM**，发布前会校验，避免扩展加载异常。

---

## 深入文档

- 进阶用法、请求签名机制、devtools / api 工具用法、日志分析套路、改脚本守则：**`SKILL.md`**
- 一键市场「可议价」判定领域术语：**`CONTEXT.md`**
- 版本变更历史：**`CHANGELOG.md`**
- 使用手册（Wiki）：<https://github.com/Bigbo12138/reelax-script-dev/wiki>

## 致谢

继承自 B 站 UP 主 **金桔猪** 的原始脚本，改造为兼容 Chrome / Edge 的 MV3 扩展并持续扩展功能。

## 许可

[MIT](./LICENSE)
