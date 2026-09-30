---
name: reelax-script-dev
description: Reelax 钓鱼游戏浏览器脚本开发与运维技能。当用户提到 reelax、自动补满杆数/次数、自动加点、自动出售、自动切图、跟随船、日志分析、script-api 文档、Python 桥、api.py、签名请求、devtools 时使用。包含插件详情、官方文档索引、日志分析方法、Python 桥与 devtools 工具说明与开发提示。
---

# Reelax 脚本开发技能 🍊

针对 `firefoxfish` 浏览器扩展（Reelax 钓鱼游戏自动化）的开发与运维指南。改脚本、看日志、排查问题前先读本文件。

## 1、插件详情

`/workspace/firefoxfish/` 原为 Firefox 扩展（MV2，web-ext 启动），**已改造为 Chrome/Edge 扩展（Manifest V3）**：后台改为单一 Service Worker（入口 `background-boot.js`，用 `importScripts` 按序载入 background/domclick/api/bridge/monitor），`browser.*` API 由 `chrome-polyfill.js` 桥接为 `chrome.*`（Promise 版）。`injector.js` 负责把 `scripts/` 下的 userscript 注入游戏页面。脚本均为 Tampermonkey 格式（`@grant none`，运行在页面上下文直接读 `window.arcaneReelax`）。改动要点：MV3 无 `webRequestBlocking`，因此「屏蔽 Cloudflare 信标」与 `filterResponseData` 同步捕获在 Chrome 下停用；加载请在 chrome://extensions 开启开发者模式「加载已解压的扩展程序」。

| 文件 | 职责 | 日志 TAG |
|------|------|----------|
| `scripts/聚合.js` | 主脚本：自动切图 + 杆数补满 + 换鱼饵 + 签到 + 弹窗处理（断线重连/加点/webhook 已移交扩展 monitor.js）；**确定「优选地图」时通知后台开公会增益**（见下） | `[AutoMap]` |
| `scripts/自动加点.js` | ~~已废弃~~（加点已迁移到扩展 monitor.js，不再注入） | — |
| `scripts/自动出售库存.js` | 定时切到库存页自动出售 | `[Reelax 自动出售]` |
| `scripts/自动补满次数.js` | 独立版杆数/次数补满 | `[Reelax 自动补满]` |
| `scripts/自动登录.js` | 自动登录 | `[Reelax 自动登录]` |
| `scripts/日志收集.js` | 收集页面 console 日志写文件 | `[Reelax 日志]` |
| ~~`scripts/自动增益.js`~~ | ~~已移除~~（不再注入；开增益改由 聚合.js 的「优选地图」通知驱动） | — |
| `bridge.js` | **Python 桥**：background 脚本，**WebSocket 持久连接**（ws://127.0.0.1:55004，断线自动重连 + 15s 心跳），收 Python 下发任务、在扩展上下文签名请求 reelax.cn、回传结果；附带登录保活探测 | — |
| `monitor.js` | **扩展监控**（后台统一接管在线检测）：webRequest 监听 fishing/sync|state 心跳 + proof 自动验证（30s `/api/me` 主动 + 响应头被动捕获）+ 掉线/登录失效时刷新标签页 + **自动加点**（签名调 `/api/player/stats/allocate`）+ **自动加专精**（每 10 分钟 `/api/mastery/{mapId}/contribute-all`）+ **自动开公会增益**（由聚合优选地图通知驱动，见下）+ **保底监控**（定时签名查 `/api/statistics` 的 pity 字段，奥秘/奇异出货、软保底满、逼近硬保底时 webhook 通知）+ **统一 webhook 通知**（掉线/登录失效/加点/页面切图） | `[monitor]` |
| `background.js` | 自动开页 / 注入额外脚本 / 自动刷新 / 日志落盘 | — |
| `popup.html/js` | 工具栏弹窗：显示桥状态（连接/登录态/proof/任务耗时）| — |
| `options.html/js` | 设置页：目标 URL、额外脚本、自定义代码、自动刷新、**桥端口、登录保活间隔、扩展监控（掉线阈值/proof 验证间隔/刷新冷却）** | — |

### 聚合.js 核心机制（重点）

- **数据获取**：优先用游戏内置 API `window.arcaneReelax` 的 `getSnapshot()`（零 HTTP 请求）；API 未就绪时回退「API 直调」请求 `/api/*`。
- **地图优先级**（`state.mapPriority`）：赛事 > 跟随船 > 金风 > 经验 > 各种天气 > 奥术涌动。只尝试到「经验」为止，其后不自动切图。
- **跟随船**：`pickFollowBoat()` 在组队船中不主动换图，锁在船所在地图（`party.boatBiomeId`）。**船过期**（`rentalEndsAt` 租赁到期 / `maintenanceDueAt` 保养逾期）或**船图玩家未解锁**（不在 `unlockedBiomes`）时，`return null` 让优先级循环继续 fallback 到天气等，并在 `state.followBoatFallback` 记录原因（只在状态切换时打一次日志）。
- **船长/舵手自动开船**（`state.autoSail`，设置页总开关，默认开）：船长/舵手且 `party.canChangeBoatBiome && party.status === 'active'` 时，**先判断船长本人当前图（`isCurrent`）是否 ≠ 船图（`party.boatBiomeId`）**——若不一致且本人图已解锁，则整船开往**本人图**（手动切图船立即跟随）；本人图已与船图一致时退回 `pickOptimalIgnoringBoat()` 算出的整船最优图。目标 ≠ `party.boatBiomeId` 则调 `gameApi.party.travelTo()` 整船切图（`sailBoat()`，无 HTTP 兜底）；船员/开关关/船不可移动时走原跟随船逻辑。`party.travelTo()` 失败仅报错，不刷页。**统一规则**：只要是能开船的船长，赛事/雷暴/优选等**任意优先级触发的脚本切图都整船 `party.travelTo`**（个人切图分支 `switchBiome` 仅在非船长/不能开船时走），船始终跟随船长。开船逻辑抽成 `executeSail()` 供「跟船优先级胜出」与「船长模式脚本切图」复用。
- **杆数补满**（见下文第 4 节刷新机制）：服务端时间精确调度为主（`snapshot.fishing` 算下次补杆时刻），DOM 兜底节流 30s；到点调 `game.fishing.refill()`，失败回退 DOM 点击。
- **经验加成（选图）**：`calculateExpBonus()` 把各乘区（天气/公会图腾/公会区域/专精/天赋/buff）**乘算**合成（`(1+a/1e4)×(1+b/1e4)×...-1`，基点返回），与游戏实际经验乘算一致；加法会低估组合加成导致选图偏差。
- **经验优选优先级**（`mapPriority` 可排入 `experience`，参考 dip.js/上游 `calculateTotalExpBonus`）：`pickExperience()` 用 `calculateExpPriority()` 做**纯经验乘算**排序（天气×地图专精×公会区域×公会图腾×buff/天赋×船队加成×可选地图号位），只挑经验加成最大的图。与「优选」的区别：经验优选**始终计入地图专精**（不受「优选剔除专精增益」开关影响）、默认算**船队加成**（`partyBonusBasisPoints`，跟船才有；全局、只抬总额不改变图间排序、`expPriorityIncludePartyBonus` 可关）、可选按**地图号位**乘经验倍率（`expPriorityIncludeMapLevel`，默认关，因无官方明确的地图经验字段）。数据来源：天气=`WEATHER_DEFS`、专精=`biome.masteryXpBonusBasisPoints`、公会区域=`biome.guildXpBonusBasisPoints`/`guildBoost`、图腾=`run.effects.guild.experienceBonusBasisPoints`、船队=`lastResult.partyBonusBasisPoints`。
- **每日签到**：优先官方 API `dailyCheckIn.claim()` + `ui.dismissReminder('daily-check-in')`（不依赖弹窗 DOM），API 不可用/失败时回退 DOM 点击。

### 自动加点（已迁移到扩展 monitor.js）

`自动加点.js` 已废弃（不再注入）。加点由扩展统一处理：monitor.js 从 sync 的 `playerPatch.unspentStatPoints` 检测到待分配点数 >0 → 签名调 `/api/player/stats/allocate` 一次性全加（目标属性在设置页 `statTarget` 配，默认运气）。加点完成发 webhook 通知。

### Python 桥（bridge.js ↔ api.py）

桥端口默认 **55004**（`bridge.js` 从 storage 读，设置页可改；`api.py` 用 `--bridge-port` 对齐）。

- `bridge.js`：background 脚本，作为 **WebSocket 客户端**连本机桥服务端（默认 `ws://127.0.0.1:55004`），断线自动重连（延迟 1s → 上限 30s）、应用层心跳保活（每 15s 发 `{type:'ping'}`，服务端回 `{type:'pong'}`）。收 Python 下发的 `{id,method,path,body}` → 页面上下文签名执行 → 回传 `{id,status,ok,data,raw}`。**403 REQUEST_SIGNATURE_INVALID 自动重置 proof 重试一次**。
- **登录保活探测**：每 5 分钟（设置页可配）直接 fetch `/api/me`（免签、**不走桥队列**），失效时自动刷新 reelax 页面恢复。
- 桥状态写入 `window.__bridgeStatus`（connected / proofOk / loginOk / lastTaskMs / taskCount），popup 展示。

### 扩展监控（monitor.js，后台统一接管在线检测）

页面脚本（聚合.js）已移除断线重连，掉线/登录态/proof 全部由扩展后台 `monitor.js` 负责，不依赖页面注入：

- **心跳**：`webRequest.onCompleted` 监听 `*://reelax.cn/api/*`，fishing/sync|state 请求更新 `lastActivityAt`；顺带从任何响应头捕获 `x-arcane-request-proof` 实时更新 proof。
- **sync 数据捕获**：`webRequest.filterResponseData` 读取 fishing/sync|state 响应体（原样 write 回，不阻塞页面），提取精选字段（剩余杆数/本批次金币/今日净赚/等级金币/船信息/在线人数）存 `__monitorStatus.sync`，popup「游戏状态」区块展示。
- **proof 主动验证**：每 `proofCheckSec`（默认 30s）fetch `/api/me`，200 则登录态正常 + 刷新 proof；非 200 判定登录失效 → 刷新页面恢复。
- **掉线检测**：每 15s 检查，超过 `offlineCheckMin`（默认 2 分钟）无心跳 → 刷新所有 reelax.cn 标签页；启动有 60s 宽限期。
- **防死循环**：刷新冷却 `reloadCooldownSec`（默认 60s），冷却期内不再刷新。
- **统一 webhook 通知**：扩展持有 `webhookUrl`（设置页配），发掉线/登录失效/加点通知；页面脚本通过 `window.postMessage({__reelaxWebhook:true,text})` → injector.js → `runtime.sendMessage({type:'reelax-webhook'})` 调扩展发（聚合.js 的切图/切图异常通知走此通道，页面不再自己 fetch webhook）。
- **自动加点**：sync 检测 `playerPatch.unspentStatPoints > 0` → 签名调 `/api/player/stats/allocate` 一次性全加（目标属性 `statTarget` 配置，默认运气）。**签名复用 bridge.js**（monitor 的 `signedFetch` 包装 `bridgeSignedRequest`，403 自动 `bridgeResetProof` 重试；monitor 从 webRequest 响应头捕获的新 proof 回填 `bridgeUpdateProof`，桥签名一直用最新令牌）。
- **自动加专精**：每 10 分钟把当前地图（`sync.boatBiomeId`）专精点全投：`/api/mastery/{mapId}/contribute-all`（无请求体，页面上下文签名）。
- **自动开公会增益（由聚合优选地图驱动）**：不再自行匹配赛事/天气，也不再设定时兜底（聚合.js 本身每 ~30s 检查一次优选）。由 聚合.js 在 `checkAndSwitch` 确定目标「优选地图」时经 `notifyPreferredBoost()` → `window.postMessage({__reelaxAutoBoost})` → injector.js → `runtime.sendMessage({type:'reelax-auto-boost'})` → monitor 的 `handleAutoBoost` 处理：
  - 目标图 = 聚合选定的 `best.biome`（含赛事/跟船/最优图等一切选图决策）。
  - **跟随船开增益门槛**：跟随船仅在船图是「待开增益最优图」时才开增益；该最优图候选**限制为船能到达的范围**（`requiredLevel ≤ 船当前图的 requiredLevel`，不拿玩家个人可去的更高等级图——如玩家能去 b_015、但船最高只能去 b_014——来比），并且**忽略“已有增益”**（带增益的图经验分虚高、会永久锁死为最优，导致没增益的高倍率图如 b_014 永远开不出增益；剔除后最优=当前最值得开增益的图）。赛事图恒定开。
  - **份数规则**：`priorityType==='competition'` → 按赛程剩余时长动态折算（每场 60 分钟，赛程剩 25 分只开 1 份，不足 1 份<30分钟按折算规则处理；不在比赛时段时兜底固定 2 份/1h）；非赛事份数按目标图天气剩余分钟向下取整到 30 的倍数（如 1h40 → 3 份），**天气未知或剩余不足 1 份(<30分钟) 时不开**（避免浪费）。
  - **开前校验**（`openAutoBoost`）：同一地图 5 分钟冷却 + 目标地图已有未过期增益（`guildBoosts` 的 `isActive===true`）则不新开，**防止多开**。
  - 结果写入 `m.autoBoost` + `m.autoBoostHistory`（持久化 `reelax-auto-boost`），popup「自动开增益」面板展示。
- **保底监控**：定时（`pityCheckSec`，默认 600s）签名 GET `/api/statistics`，取 `pity` 字段（exotic/arcane 的 `currentDryCasts` / `maxDryCasts` / `hardPityCasts`，服务端保底计数器）。每个「保底循环」去重通知一次，通知标志持久化在 `reelax-monitor-stats.pityNotified`（连同上一次干涸计数 `pityBaseline`，重启后仍能检测关闭期间是否出货）：
  - **出货**：`currentDryCasts` 大幅回落（计数器重置）→ `🎉 奥秘鱼出货` / `✨ 奇异鱼出货`（通知间隔杆数，重新武装标志）；
  - **软保底满**：`currentDry >= maxDry` → `⚠️ 保底已满，随时可能出货`（注：API 的 maxDry 显示为 `max(阈值, currentDry)`，越过后恒等于 currentDry）；
  - **逼近硬保底**：`hardPity - currentDry <= pityHardMargin`（默认 1000）→ `🚨 即将必出`。
  - 进度百分比 `pct = currentDry / hardPity`（到硬保底 = 100%，可超过 100%），并带**距硬保底剩余时间**（剩余杆数 × 6 秒/杆）。webhook、日志与 popup 一致，如 `[monitor] 保底: 奥秘 62.7%（21481/34236，约21时16分） | 奇异 60.6%（4294/7090，约28分）`。
  - 配置：`pityMonitor` / `pityCheckSec` / `pityHardMargin`（设置页）。状态挂 `m.pity`（含 `pct`）；popup「奥秘保底 / 奇异保底」两行显示进度百分比 + 剩余时间（悬停看当前杆数/软保底/硬保底，软满/临硬保底标红）。
- **保底触发（pity-trigger）**：开关 `pityTriggerArcane` / `pityTriggerExotic` 各自独立。**核心改为记录「奥秘涌流天气下的全加运气」硬保底杆数作为触发基准 `ref`**（服务端硬保底随有效运气动态下发，客户端无公式，故以实测为准）：
  - **记录/持久化**：`m.pityTrigger.ref = { arcane, exotic, built, builtAt }` 始终持久化到 `reelax-monitor-stats.pityTrigger.ref`，SW/插件重载不丢。
  - **只在「奥秘涌流 + 全加运气」窗口记录**（`recordRefNow = inSurge && isAllLuckNow`）。`/api/statistics` 硬保底杆数只在涌流天气下有意义，涌流外的全运气读数不代表涌流保底，不清/不更 ref。
  - **首次建基**：`ref.built=false` 时，在**首个奥秘涌流窗口**内自动执行「洗点→全加运气→读 `/api/statistics` 硬保底→存 ref→洗回」（`buildRefBaseline`，带 `inSurge` 内保），短暂打断在线后恢复原加点/原饵；非涌流/比赛中先不开火，等下一个涌流窗口补建。
  - **自动刷新**：每当检测到「奥秘涌流 + 用户正处全运气加点」（`isAllLuckNow`：`base.luck/sum(base) ≥ 80%`），自动用当前硬保底更新 ref（`updateRefFromStats`）。比赛中虽冻结主动洗点/洗回，但正处涌流全运气时**仍会**更新 ref。触发洗点后若在涌流内也立即刷新。
  - **触发**：非全运气时，该类型 `currentDry ≥ ref.<type> 硬保底` → **洗点→全点运气**，直到「对应鱼出货」才洗回（复用比赛后加点方案 `computeStatPlan`：力量补到 `strengthTarget`，剩余给 `allocSecondary`）。两开关任一达到基准就洗全运气，最后那个出货后才洗回。
  - 可选 `pityTriggerSurgeOnly`（仅奥秘涌流触发）：默认只在 `m.arcaneSacrifice.surge.isActive` 为真时才跑保底触发，涌流结束视为功能关闭并洗回。
  - 可选 `pityTriggerTopBait`（自动顶级饵）：开启后洗点成功后自动换**顶级饵 `bait_supreme`**（`/api/baits/bait_supreme/equip`），库存为 0 自动买 100 个（`/api/baits/bait_supreme/purchase {quantity:100}`，约 10 万金），买不起/失败则保持当前设定饵；功能关闭/洗回/比赛接管时恢复 `m.pityTrigger.preBait` 原饵。
  - active 期间**抑制内置自动加点**（`autoAllocate` 返回 `pity-trigger-locked`）。比赛中（`m.compActive`）冻结主动洗点/洗回、先 `pityTriggerRelease()` 让位，但涌流全运气观测仍更新 ref。popup「保底触发」行显示待命/等涌流/全运气锁 + 基准值。
- 状态写入 `window.__monitorStatus`（enabled / lastActivityAt / idleSec / loginOk / proofOk / proofUpdatedAt / reloadCount / lastReloadReason / sync / autoAllocate / lastAllocateAt / pity / lastPityError），popup 展示。
- 配置：`monitorEnabled` / `offlineCheckMin` / `proofCheckSec` / `reloadCooldownSec` / `webhookUrl` / `autoAllocate` / `statTarget` / `autoMastery` / `pityMonitor` / `pityCheckSec` / `pityHardMargin`（设置页，storage 热更新）。

## 2、官方文档

完整文档：<https://reelax.cn/docs/script-api.md>

登录后游戏通过 `window.arcaneReelax` 暴露不可变、版本化 API（`apiVersion: 1`），只映射前端内存，不额外发请求。

### 快速接入

```js
const game = window.arcaneReelax;         // @grant none 下直接读
const snapshot = await game.ready;        // 首份快照
// 之后同步读：game.getSnapshot()、biomes.getAll()、biomes.getCurrent()、party.getCurrent()
```

### 关键字段/方法（与脚本强相关）

- `snapshot.fishing`：有批次时为 `{ status, mode, totalCasts, remainingCasts, cycleDurationMs, nextCastAt }`；无批次为 `null`。**补满阈值应基于它算，而不是猜**。
- `snapshot.party`：`{ isInParty, role, boatName, boatBiomeId, rentalEndsAt, maintenanceDueAt, ... }`。船过期/保养判断用这两个时间。
- `fishing.refill()`：**脚本补满唯一正道**。仅当批次运行中/已完成且剩余**严格少于总次数一半**才真正 `POST /api/fishing/refill`；否则返回 `false`。服务端仍做幂等/签名/频率预算校验。
- `fishing.selectBait(baitId)`：换鱼饵，下一杆生效。
- `biomes.travelTo(biomeId)`：个人切图；`party.travelTo()`：船长/舵手整船切图（聚合.js 自动开船走这个）。
- 事件：`on('weather:changed'|'guild-boost:started'|'guild-boost:ended'|'competition:started', fn)`，返回退订函数。
- 冻结对象：快照与嵌套数组均被冻结，只读，不要尝试修改。

### 红线

- **不要用 `.click()`/`dispatchEvent()` 合成点击补满按钮**——顶部状态区/钓鱼页补满按钮只响应 `isTrusted` 用户事件，首次合成点击会弹出文档提示，之后被静默忽略。统一用 `game.fishing.refill()`。
- 登录后的直接 `/api/*` 请求会被**短时请求签名**校验 + 会话共享频率预算限制；优先用内置 API 快照，避免粗暴轮询。

## 2.5、请求签名机制（devtools 逆向成果）

所有 `/api/*` 请求都要求签名，裸 fetch 会 403 `REQUEST_SIGNATURE_INVALID`：

```
待签明文 = "v1\n" + METHOD大写 + "\n" + url(path+query) + "\n" + 毫秒时间戳 + "\n" + body
签名     = base64url( HMAC-SHA256( key=proof令牌, msg=待签明文 ) )
请求头   = x-arcane-request-proof / x-arcane-request-timestamp / x-arcane-request-signature
```

- `proof` 是**会话级稳定令牌**（payload 含 expiresAt），由任意 API 响应的 `x-arcane-request-proof` 头下发；`/api/me` 免签且会下发它，用于引导后续签名。`sign.js`/`bridge.js` 都会缓存 proof，**403 时自动重取**。
- 市场页筛选参数名 ≠ API 参数名（经页面 `NL()` 映射）：`gearRarities→rarities`、`gearMaxPrice→maxPrice`、`gearMinPrice→minPrice`、`gearSlot→slot`、`gearStat→stat`、`gearMinQuality→minQuality`、`gearMinUpgrade→minUpgradeLevel`。
- 免签白名单：`/api/auth/login`、`/api/auth/register`、`/api/content/bootstrap`、`/api/integrations/afdian/webhook`、`/api/meta/frontend-release`。

## 2.6、devtools 工具集

`/workspace/firefoxfish/devtools/`，全部仅标准库，**端口自动识别**（`resolve_port`：显式 `--port` > 从 firefox 进程/启动日志找 `-start-debugger-server` > 兜底 36353）。

| 文件 | 用途 |
|------|------|
| `rdp_query.py` | RDP 客户端（`<长度>:<JSON>` 帧）。命令：`list` / `info` / `eval <expr>`（同步）/ `evala <expr>`（**await Promise**）+ `--js-file`（先注入文件如 sign.js） |
| `list.py` | 页面搜查：`tabs` / `search <词>` / `sel <CSS>` / `class <子串>` / `text <CSS>` / `gold` / `relic` / `fragment` |
| `market.py` | 市场订单查询（**走 WS 桥** `ReelaxApi.market_orders`，原 RDP 注入方式已弃），`--rarities --max-price --side --limit` 等，`--raw` 看原始 JSON |
| `api.py` | **扩展桥客户端（首选）**：本地 WebSocket 桥 `127.0.0.1:55004`（`ws_bridge.py` 起服务端）+ 全部只读/写方法。见「WS 桥教程」 |
| `guild_stats.py` | 公会成员四维（力量/运气/智力/耐力）分析：总表 + 分布图 + 各维 TOP + 阵营/流派分布，可导出 JSON/CSV。见下 |
| `sign.js` | 注入页面后定义 `window.__sign`（`getProof`/`resetProof`/`sign`/`signedFetch`/`signedGet`），签名请求库 |

### WS 桥教程（api.py + ws_bridge.py，首选，默认端口 55004）

**架构**：`devtools/ws_bridge.py` 在本机 127.0.0.1:55004 起 **WebSocket 服务端**；扩展后台 `bridge.js` 作为 **WS 客户端**主动连上并保持长连接（断线自动重连 ≤30s、15s 应用层 ping/pong 心跳）。Python 下发 `{id,method,path,body}` → 扩展在页面上下文签名执行 → 回传 `{id,status,ok,data,raw}`。全双工、无轮询。

```bash
python3 devtools/api.py me                                                    # 单次：自起服务端→等扩展→发请求→退出
python3 devtools/api.py market-orders --rarities legendary --max-price 500000 --side sell --limit 10
python3 devtools/api.py market-config / market-fish-overview / market-my-orders / market-my-trades
python3 devtools/api.py fishing-state / biomes / weather --biome b_003
python3 devtools/api.py mastery / mastery-talents / baits / inventory-gear / statistics / guilds-me
python3 devtools/api.py raw "/api/mastery"                                    # 任意路径
python3 devtools/api.py raw "/api/fishing/custom-statistics/history"          # 慢接口（见下）
python3 devtools/api.py serve                                                 # 常驻桥（默认端口 55004）
```

也可作库：`from api import ReelaxApi; api = ReelaxApi(); api.market_orders(rarities=['legendary'], max_price=500000)`。

**两种用法**：
- **常驻 serve**：`api.py serve` 让服务端一直跑（扩展只认这一个端口），之后所有 `api.py` 命令发现端口被占用自动**降级 client 模式**连接现有服务端。

**关键行为**：
- 端口被占用 → 自动降级 client 模式连现有服务端；**client 模式回包由服务端转发**——`ws_bridge.py._handle_conn` 收到控制器请求后 `_forward` 转给扩展，拿到回包再 `conn.send_text` 回给发起方（**2026-08-13 修复**：此前回包被丢弃，client 模式必 `bridge-timeout`）。
- 服务端 `_forward` 等扩展回包上限 **30s**（`EXT_READ_TIMEOUT`），超时回 `bridge-timeout(扩展响应超时)`。
- api.py 客户端默认 `--timeout 20`；**重接口**（如 `/api/fishing/custom-statistics/history`，服务端计算有时 >30s）用 `--timeout 60`，但服务端 30s 上限仍可能卡——超时属接口慢、不是桥坏，重试即可。

**日志解读**：`🔗 扩展已连接: <port>` / `🔌 连接断开: <port>` 是**任何**客户端（含 api.py 临时客户端）的连接日志，不代表扩展本体。判断扩展是否在线：看是否存在一条长期稳定不掉的连接。

**排错**：
- `扩展未连接`：serve 没起 / 扩展没加载（run.sh 没跑）/ 端口与扩展设置页不一致（默认 55004）。
- `bridge-timeout`：扩展收到请求但 30s 内没回包。①重接口服务端算太久（见上，重试）；②扩展后台 `pageSignedFetch` 卡住（它用 `tabs.executeScript` 每次注入页面签名，偶尔会卡，见 RDP 教程对比）；③旧版 client 模式回包断链 bug（升级 ws_bridge.py 即可）。

**为什么不直接用 HTTP**：Firefox 对 localhost HTTP 有 stall 问题（当初 HTTP→WS 的原因），WS 本地持久连接更稳。且登录 cookie 是 **HttpOnly**（`document.cookie` 为空）→ 纯 Python 脱离浏览器拿不到会话，必须走扩展桥或 RDP。

### guild_stats.py 用法（公会四维分析）

```bash
python3 devtools/guild_stats.py 10013                    # 公会 ID
python3 devtools/guild_stats.py "https://reelax.cn/guilds/10013?view=members"   # 或直接贴链接
python3 devtools/guild_stats.py 10013 --top 10 --sort luck
python3 devtools/guild_stats.py 10013 --json out.json --csv out.csv
python3 devtools/guild_stats.py 10013 --stdout-json      # 只吐 JSON，便于管道
```

数据来自 `/api/guilds/{id}`、`/api/guilds/{id}/members`（cursor 翻页）、`/api/players/{publicId}/statistics`
（四维在 `rankings.attributes`，`category = attribute:strength|luck|intelligence|endurance`，带全服 `rank`）。

- 成员数 N 就发 N+2 个请求，**串行 + 节奏控制**（`--delay/--jitter`，默认 0.35+0.35s），避免撞会话频率预算。
- 单个成员失败不中断，末尾统一列出。
- 两个指标别混淆：**主占比** = 最高一维占四维之和的比例；**专精度** = 归一化 HHI（0=四维完全均衡，1=全堆一维）。
  所以「极端 X」（主占比≥55%）配低专精度是正常的——剩余三维分得越均匀，HHI 越低。
- 流派判定阈值：主占比 ≥55% 极端 / 前二合计 ≥72% 且差距 ≤15% 双修 / ≥40% 主 / ≤30% 均衡 / 其余 偏。

### RDP 单独连教程（rdp_query.py，不需要桥）

**原理**：web-ext 启动 Firefox 时带 `-start-debugger-server <随机端口>`，`rdp_query.py` 自动检测该端口（显式 `--port` > firefox 进程 > 启动日志 > 兜底 36353），直接连 Firefox、在**页面主世界**执行 JS。不需要 serve / WS / 扩展桥，页面已登录会话直接用。拉数据比桥稳（绕开 `tabs.executeScript`），适合临时查询；写操作/常驻脚本仍建议走桥。

```bash
python3 devtools/rdp_query.py list                                    # 列标签页 + 端口
python3 devtools/rdp_query.py eval "location.pathname"                # 同步表达式（tab 0）
python3 devtools/rdp_query.py eval --tab 1 "window.arcaneReelax.getSnapshot().player?.gold"
python3 devtools/rdp_query.py evala --js-file devtools/sign.js \
  "window.__sign.signedGet('/api/statistics')"                         # 注入 sign.js + 异步签名请求
```

**签名请求**：`--js-file devtools/sign.js` 先注入（定义 `window.__sign`：`getProof`/`resetProof`/`sign`/`signedFetch`/`signedGet`），再 `window.__sign.signedGet(path)`。proof 从 `/api/me` 响应头取（免签端点）。注意 `getProof()` 只取一次缓存，proof 失效时先 `await window.__sign.resetProof()` 再请求。

**实测坑（必看）**：
1. **返回值要短**：RDP 回传大对象/长字符串会被截断成 `(null)`（约 700 字以内稳）。拉大接口（statistics/history）时在页面里**自己摘要成小字符串**再 return。
2. **`evala` 共用 `window.__rdpAsync` 结果变量**：某次调用卡住/超时会残留旧值，下次读到的是旧数据。先 `eval "window.__rdpAsync=null;'cleared'"` 清掉，或让表达式返回独特标记来区分。
3. **慢接口**：`/api/fishing/custom-statistics/history` 服务端计算重、响应飘忽（有时 <30s、有时 >120s），`--timeout` 给足（30~90s），失败就重试。
4. **诊断接口通不通**：裸 `fetch(path)` 不签名——8ms 回 403 说明接口本身快、只是要签名；签名后一直卡 = 服务端慢或频率预算耗尽。
5. **会话频率预算**：reelax 有会话级频率预算，连续锤重接口会耗尽，之后签名请求 hang。别对同一接口连拉；耗尽了等几分钟再试。

### api/ 逆向与分析工具

`/workspace/firefoxfish/api/`：API 逆向与游戏经济分析（纯标准库）。

| 文件 | 用途 |
|------|------|
| `api.md` | 全量 `/api/*` 端点文档（`parse_apis.py` 生成/比对） |
| `parse_apis.py` | 从线上 bundle 提取 `/api/*` 路径、免签白名单、HTTP 方法，`--diff api/api.md` 比对增删 |
| `fish_economy.py` | **钓鱼收益模型与加点分析**：公式逆向自线上 bundle，已用实测会话校准（总鱼数误差 0.6%）。核心关系：力量→单杆上限 `ly(rarity,str)`、智力→经验/金币、运气→9稀有度权重。命令：`thresholds`（力量阈值表）/ `dist`（9鱼分布）/ `cast`（单杆期望收益）/ `alloc`（加点方案+边际价值）/ `guide`（**加点收益表**：力量档位·运气边际·按总基础点推荐分配）/ `sweep`（运气·力量扫描） |
| `history_economy.py` | **历史真实收益对比**：读 `/api/fishing/custom-statistics/history` 的渔获汇总，按饵聚合真实净收益（鱼价值+直接金币-饵钱），与 `fish_economy.py` 模型交叉验证。**鱼价口径 `--price`：默认 backpack=背包实际出售价**（读 `api.py inventory-fish` 输出，史诗按背包实价），base=模型基础价，market=市场倍率。**实测发现模型高估史诗+ 概率 2~7 倍、低估顶级饵收益**（详见下文已知结论） |
| `gear_advisor.py` | **装备/鱼竿升级建议**：回答"升鱼竿还是换/买装备"。力量是阶梯函数（不跨档收益 0），脚本枚举「免费换装（背包闲置高属性装备）→ 装备强化（几十万/件补缺口）→ 升竿（最后手段）」的最小成本组合跨目标力量档，收益按真实状态 + 背包价算。在线走桥拉 `me`/`gear/loadouts`/`inventory/gear`/`rods`；离线用 `--me-file --loadouts-file --gear-file --rods-file`。关键参数：`--target <力档>` 只看指定档、`--budget <金>` 限制预算、`--buff-bp` 运气增益（默认 0）、`--bait/--weather/--price` |

```bash
python3 api/fish_economy.py dist                        # 当前属性 9 鱼分布
python3 api/fish_economy.py cast --margin market        # 单杆期望收益（传奇+按市场价）
python3 api/fish_economy.py alloc --bait medium         # 加点对比（换中级饵）
python3 api/fish_economy.py guide                       # 加点收益表（力档位/运边际/推荐分配）
python3 api/fish_economy.py sweep                       # 找最优力量/运气分配
python3 api/history_economy.py                          # 历史窗口按饵聚合净收益 + 模型对照（默认背包价）
python3 api/history_economy.py --price base            # 模型基础价口径
python3 api/history_economy.py --bait-detail           # 逐窗口明细
python3 api/gear_advisor.py                            # 装备/鱼竿升级建议（在线走桥）
python3 api/gear_advisor.py --target 11500             # 只看 11500 力量档的跨档方案
python3 api/gear_advisor.py --budget 5000000           # 限制预算 500 万
python3 api/gear_advisor.py --me-file /tmp/me.json --loadouts-file /tmp/lo.json \
    --gear-file /tmp/gear.json --rods-file /tmp/rods.json   # 离线模式（桥不可用时）
```

**已知结论（2026-08-12/13 玩家 valetzx）**：当前 4048 基础运气已严重溢出（运气每 1000 点边际仅 +19 金/杆）；力量卡在 6291 阈值空档（下一档 7500）；**顶级饵（supreme）实测最赚钱**——历史 7 窗口 1.3 万杆净 +1414/杆（背包价口径，默认）/ +1551/杆（base）/ +2945/杆（market），**按真实经过时间 ≈82.6万金/时（≈1982万金/天）**，史诗+ 占比 8.5% 是中级饵（1.9%）的 4.5 倍、高级饵（3.9%）的 2.2 倍。注意：supreme 的利润大头是"鱼的价值"，纯直金现金流（直金−饵钱）为负（约 -800/杆，游戏自身 netGold 字段），须卖鱼才兑现。模型曾推断"顶级饵不如中级饵"，但模型把史诗+ 概率高估 2~7 倍（如中级饵模型预测 14.7% 实际仅 1.9%），该结论已被历史数据推翻；保底由服务端 `/api/statistics` pity 字段控制（奥秘软保底 21163 / 硬保底 32826），见扩展「保底监控」。

## 3、日志分析

### 日志位置

`/home/ubuntu/Downloads/logs/`，格式 `reelax-YYYYMMDD-HHMMSS.log`（按启动时刻命名，一天多个）。行格式：

```
[HH:MM:SS.mmm] [log|warn|error] [TAG] 内容
```

### 分析套路

1. **先扫错误/警告**：`grep -iE 'error|warn|失败|超时|403|fallback' /home/ubuntu/Downloads/logs/reelax-<日期>-*.log | wc -l`。
2. **看主线决策**：`grep -E 'bestBiome:|reason:|切换:|跟随船' ...` → 判断脚本一直在干嘛（跟船 / 等金风 / 蹲经验图）。
3. **看自动加点**：`grep '自动加点' ...` → `待分配点数=`、`设置 运气 分配 = N` 每轮分配。
4. **看补满是否真触发**：`grep -E '低于一半|补满|refill' ...`。注意：启动消息「杆数监控已启动」≠ 触发过补满；要有 `低于一半，已调用游戏内补满` 才算真正发生。
5. **看保底监控**：`grep '保底' ...` → 每轮检查日志 `[monitor] 保底: 奥秘 64.9%（18063/32826）| 奇异 32.1%（9000/28000）| 有效运气 N`（**百分比为主：到硬保底=100%，可超100%**；括号里是当前杆数/硬保底）。异常看 `保底查询失败` / `保底解析失败`。首次启用时若有 `⚠️ 奥秘保底已满` webhook 属正常（当前就在软保底）。

### 已知高频现象

- **`REQUEST_SIGNATURE_INVALID` 403 一串**：刚刷新页面、内置 API 未就绪那几秒，脚本临时走 API 直调撞上过期签名。**自愈，无需处理**；等 `window.arcaneReelax` 就绪切回零 HTTP 快照模式即恢复。集中在页面刷新前后是正常表现。若是**持续** 403（桥查询或脚本 API 直调一直失效），检查 proof 是否过期——新版 sign.js/bridge.js 已自动重取，旧逻辑需刷新页面。
- **`[加点诊断] 分配按钮= 未找到`**：属性卡片还没渲染，脚本会重试；连续无进展才放弃回钓鱼页。
- **跟随船但看不到对比日志**：说明运行的是旧版 聚合.js（对比/过期 fallback 是后加的），需要重新加载扩展脚本。
- **桥查询超时（bridge-timeout）**：先看 serve 日志确认扩展本体在线（「扩展已连接」日志包含所有客户端，不一定是扩展）；再确认端口与扩展设置页一致（默认 55004）。扩展在线仍超时：重接口超过服务端 30s 上限属正常（重试即可）；一直超时检查是否旧版 client 模式回包断链 bug（升级 ws_bridge.py，见「WS 桥教程」）。

## 4、开发提示

### 杆数刷新机制（回答"为什么那么频繁"）

补满分两条路径，**服务端精确调度为主，DOM 兜底节流**：

- **服务端调度（主）**：`scheduleRefillFromSnapshot()` 用 `snapshot.fishing` 的 `nextCastAt + cycleDurationMs` **精确算**出剩余次数将低于一半的时刻，`setTimeout` 到点调 `game.fishing.refill()`。零 HTTP、零 DOM 依赖。主轮询 `checkAndSwitch` 每次拿到快照后都会重排一次。
- **DOM 兜底（节流）**：`startRodMonitor()` 用 `MutationObserver` 观察顶栏 `button.topbar-fishing-status` 里的 `<b>` 元素（格式 `当前 / 上限`，如 `214 / 236`）。每杆文本变化 observer 都会触发 `handleRodCountChange()`，但**节流 30 秒**（`CONFIG.rodThrottleMs`）才实际检查一次，且服务端已安排定时器时跳过。仅当服务端调度不可用（无 gameApi / 快照无 fishing）时 DOM 兜底生效。

触发的三道闸门（`attemptRefill()`）：
1. `refillLocked`：补满后锁 10 秒（`CONFIG.refillLockTime`），防连续调用。
2. `state.autoRefill` 开关。
3. 剩余严格低于一半（与官方 `refill()` 的规则一致）。

所以真正发补满请求的次数很少，不会撞频率预算。

### 改脚本守则

- 改完先 `node --check`（node 在 `/root/.nvm/versions/node/v22.23.1/bin/node`）或 `python3 -m py_compile`。
- 新增状态字段记得在 `state` 初始化处声明并写清注释；跨轮询共享的标记（如 `followBoatFallback`）只在状态切换时打日志，避免刷屏。
- 涉及游戏行为一律优先走 `window.arcaneReelax` API；DOM 兜底路径保留但标记为 fallback。
- 日志中文用 `\uXXXX` 转义和直接中文都行，保持 TAG 前缀统一，方便 `grep`。
- 时间字段（`rentalEndsAt` 等）用 `formatCNTime()`（上海时区）展示；比较用 `new Date(x).getTime()`。
- 改 `manifest.json`（如权限/background 脚本）后 web-ext 会**热加载**扩展，无需重启 Firefox；但新加的 storage 配置项首次使用前要确认 `options.js` 的 `DEFAULTS` 已包含。
- **扩展脚本与 Python 桥改动的对应关系**：改 `bridge.js`/`sign.js`/manifest → web-ext 热加载；改 `api.py`/`ws_bridge.py` → 重启 `api.py serve`（或直接跑单次命令）即可；改消息协议（`_forward` 的 `{id,method,path,body}` 格式）要 `bridge.js` 和 `ws_bridge.py` 两边一起改。

### 快速验证

- `?fast` / `?dev` 后缀可缩短 自动出售库存 的检查间隔到 8 秒（调试用）。
- 日志收集脚本会持续落盘，改完脚本刷新页面后观察 `/home/ubuntu/Downloads/logs/` 新文件即可确认新逻辑生效。
- **验证扩展桥**：`python3 devtools/api.py me` 秒回即桥通；`python3 devtools/api.py serve` 可单独起桥排查。
- **验证 RDP**：`python3 devtools/rdp_query.py eval "location.pathname"` 应显示当前页面路径。
