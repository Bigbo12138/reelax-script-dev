# Reelax 助手（Chrome/Edge 扩展）

浏览器启动时自动打开 [reelax.cn](https://reelax.cn/)，并向该站点注入可配置的 JS 脚本（等价油猴 `@grant none`，可直接读 `window.arcaneReelax`）。**Chrome/Edge Manifest V3** 版本（后台为单一 Service Worker，`browser.*` 经 `chrome-polyfill.js` 桥接为 `chrome.*`）。详细开发与运维说明见 `SKILL.md`。

## 功能

- **开机自动打开**：浏览器启动时自动打开目标网站（设置页可关）。
- **脚本注入**：把 `scripts/` 下的 JS（或自定义代码）注入 reelax.cn 主世界。注入器 `injector.js` 同时充当「页面脚本 ↔ 后台」的 `postMessage` 双向通道（签名 API 中继 / webhook / 同步采集）。
- **自动补满**：服务端时间精确调度为主（`snapshot.fishing` 算下次补杆时刻 → `game.fishing.refill()`），DOM 兜底节流 30s；仅当剩余严格低于一半才真正请求。
- **自动切图 + 杆数补满（聚合.js）**：赛事 > 跟随船 > 金风 > 经验 > 天气 > 奥术涌动 的选图优先级；船长/舵手自动整船 `party.travelTo()` 开船并始终跟随船长；每日签到优先官方 API。
- **自动出售库存**：定时切到库存页自动出售。
- **自动加点 / 自动加专精（monitor.js）**：检测 `unspentStatPoints > 0` 自动全加（目标属性可在设置页配，默认运气）；每 10 分钟把当前图专精点全投。
- **保底监控（monitor.js）**：定时签名查 `/api/statistics` 的 pity 字段（奥秘/奇异出货、软保底满、逼近硬保底），`pity-trigger` 可在奥秘涌流窗口记录「全加运气」硬保底基准，满保底自动洗点全加运气。
- **自动开公会增益（monitor.js）**：由聚合.js 的「优选地图」通知驱动，按赛程/天气剩余时长折算份数，防多开。
- **掉线 / 登录失效监控（monitor.js）**：webRequest 心跳 + proof 主动验证，掉线/登录失效自动刷新页面，统一 webhook 通知。
- **一键市场（一键市场.js）**：
  - 按设定在渔获页批量挂单出售（品级多选 / 单鱼数量下限 / 市场最低卖价 ± 金额）；对已有挂单的鱼先下架旧单再合并重挂；达到活动挂单数量上限自动停止。
  - **捡漏页签**：查某稀有度（奇异/奥秘等）所有鱼的市场最低价并升序列出、点击跳转。
  - **价格检测**：最低价检测一键扫非最低价卖单并下架；最高价检测扫非最高价求购单并下架。
  - **可议价提示（价差检测）**：检测中若「我的价是最优第一名」且「市场第一二档断层 `(M1−M2)/M2`」达到**按我的挂价分档**的阈值（`<1k=5%`、`1k~1w=3%`、`1w~10w=2%`、`10w~100w=1.5%`、`100w~1000w=1%`、`>=1000w=0.5%`），将该单列入「可议价」区块，勾选后**按建议价一键重挂**（卖方向=M2−1 仍最低、买方向=M2+1 仍最高，保证重挂后仍是第一名）。
- **日报采集（日报采集.js）**：从 extension 后台 monitor.js 的同步数据（`dailySyncText` / postMessage 缓存 + sessionStorage 兜底）汇总当日累计杆数 / 净赚，供日报展示。
- **市场实时行情采集（market_events.js）**：订阅市场 SSE（order-book / listing-created），经 postMessage → 桥转发给外部大屏。

## 工具栏弹窗 / 设置

- **工具栏弹窗（popup）**：一键打开目标站 / 打开设置 / 展示桥状态（连接 / 登录态 / proof）与「游戏状态」实时数据 / 奥秘·奇异保底进度 / 自动开增益面板。
- **设置页（options）**：目标 URL、注入脚本、自定义代码、自动刷新、**本机桥端口、登录保活间隔、扩展监控参数（掉线阈值 / proof 验证间隔 / 刷新冷却）、webhook URL、加点目标属性、保底监控与触发开关**。

## Python 桥（bridge.js ↔ api.py）

扩展后台 `bridge.js` 作为 **WebSocket 客户端**连本机 `ws://127.0.0.1:55004`（`devtools/ws_bridge.py` 服务端，断线自动重连 + 15s 心跳）；收 Python 下发任务、在**页面上下文签名**请求 reelax.cn、回传结果。改写协议要 `bridge.js` 与 `ws_bridge.py` 两侧同步。

```bash
python3 devtools/api.py serve                                   # 常驻桥
python3 devtools/api.py me                                      # 单次：登录态 / proof
python3 devtools/api.py market-orders --side sell --limit 10    # 市场挂单查询
python3 devtools/api.py raw "/api/mastery"                      # 任意签名路径
```

> 登录 cookie 是 **HttpOnly**（`document.cookie` 为空），脱离浏览器拿不到会话，必须走桥或 RDP。所有 `/api/*` 请求都需短时请求签名（见 `SKILL.md` 第 2.5 节）。

## 文件结构（根目录）

```
manifest.json           # 扩展清单（Manifest V3，Service Worker）
background-boot.js      # MV3 入口：importScripts 按序载入后台脚本
background.js           # 自动开页 + 注入 + 自动刷新 + 日志落盘
chrome-polyfill.js      # browser.* → chrome.*（Promise 版）桥接
injector.js             # 注入 userscript + postMessage 双向通道
domclick.js             # 页面上下文签名与点击执行
api.js                  # 签名请求库（getProof / sign / signedFetch）
bridge.js               # Python 桥（WS 客户端，55004）
monitor.js              # 后台监控：在线检测 + 加点/专精/增益 + 保底 + webhook
popup.html / popup.js   # 工具栏弹窗
options.html / options.js# 设置页
scripts/
    ├─ 聚合.js          # 主脚本：自动切图 + 补满 + 换饵 + 签到 + 优选地图通知
    ├─ 一键市场.js      # 批量挂单 / 捡漏 / 价格检测 / 可议价重挂
    ├─ 日报采集.js      # 当日累计杆数 / 净赚采集
    ├─ market_events.js # 市场 SSE 行情采集汇总
    ├─ sync-hook.js     # document_start 同步采集钩子（写 sessionStorage + postMessage）
    ├─ 自动出售库存.js / 自动补满次数.js / 自动登录.js / 自动加点.js（已废弃）/ 日志收集.js
    └─ 保底显示.js / 装备初始价显示.js / 装备属性占比.js / 以物易物价格.js 等注入脚本
devtools/               # 纯标准库 Python 工具：api.py / ws_bridge.py / rdp_query.py / market.py / guild_stats.py / sign.js
api/                    # API 逆向与收益分析：api.md / fish_economy.py / history_economy.py / gear_advisor.py
```

## 安装（临时加载，无需签名）

1. 打开 `chrome://extensions`，右上角开启 **开发者模式**。
2. 点击 **加载已解压的扩展程序**，选择本目录根（含 `manifest.json`）。
3. 扩展即生效；把扩展**固定到工具栏**即可看到弹窗。

> 临时加载的扩展在浏览器完全关闭后不会自动加载，需重新加载。改 `manifest.json` / 后台脚本后点扩展页的「重新加载」生效；改注入脚本刷新目标页面即可（web_accessible_resources 已放行 `scripts/*`）。

## 说明与限制

- **配置持久化**：所有可调项（注入脚本、桥端口、监控参数等）存 `storage.local`，设置页即改即热更新；新增 storage 配置项前请确认 `options.js` 的 `DEFAULTS` 已包含。
- **注入时机**：`sync-hook.js` 在 `document_start`（主世界），其余注入脚本在 `document_idle`，均可直读页面 DOM 与全局变量。
- **请求签名**：登录后的直接 `/api/*` 请求会受短时签名 + 会话级频率预算限制；优先用 `window.arcaneReelax` 内置 API（零 HTTP），避免粗暴轮询。
- **补满红线**：不要用合成点击补满按钮（do `.click()`），按钮只响应 `isTrusted` 事件；统一用 `game.fishing.refill()`。
- **自动登录凭据**：`run.sh --login <邮箱> <密码>` 或环境变量 `FISH_EMAIL` / `FISH_PASSWD`，生成运行期 `scripts/login_credentials.js`（`window.__REELAX_LOGIN__`），`injector.js` 先于 `自动登录.js` 注入；该文件已被 `.gitignore` 忽略、不进版本库。

## 深入文档

- 进阶用法、请求签名机制、devtools / api 工具用法、日志分析套路、改脚本守则见 **`SKILL.md`**。
- 一件市场「可议价」判定相关领域术语见 **`CONTEXT.md`**。