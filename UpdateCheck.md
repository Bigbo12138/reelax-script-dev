# 奥术摸鱼大师 上游更新检查

> 生成日期：2026-08-19（2026-08-20 更新：上游已发 1.8.0，补全 1.8.0 演进）
> 对比对象：
> - **上游**：`奥术摸鱼大师辅助` v1.8.0（Tampermonkey 油猴脚本，作者 deepseek & yy）
> - **本地**：`firefoxfish`（Reelax 助手 Firefox 浏览器扩展），聚合脚本 `@version 2.9.0`
> 对比文件：`stmp/奥术摸鱼大师辅助-latest.js`（1.8.0，本地对照/逆向参考，不入库）

---

## 一、上游从哪更新（更新源）

上游是 Tampermonkey 油猴脚本，通过脚本头部的元数据声明更新源：

| 项 | 值 |
|----|----|
| @updateURL | `https://reelax.hsiyue.com/arcane-assistant.user.js` |
| @downloadURL | `https://reelax.hsiyue.com/arcane-assistant.user.js` |
| 版本检查接口 | `https://reelax.hsiyue.com/version`（GET，返回 `{"version":"x.y.z"}`） |
| 游戏域名 | `https://reelax.abang666.com/*`、`https://reelax.cn/*` |

**更新机制**：脚本内 `checkVersion()` 每小时（启动时 + 每 60 分钟）GET `/version` 对比 `SCRIPT_VERSION`，发现新版本就在面板顶部显示「更新横幅」，点击打开 `DOWNLOAD_URL` 下载页。Tampermonkey 也会按 `@updateURL` 自动轮询更新。

**当前状态（已核实）**：`https://reelax.hsiyue.com/version` 返回 **1.8.0**；下载的 `arcane-assistant.user.js` 头部 `@version 1.8.0` / `SCRIPT_VERSION="1.8.0"`，sha256 `04bc65afdb0ba27d6001e5909c0c4b9204ebb5139db203cf98ee55d79c8ab8c1`。**上游已较旧记录(1.7.1)发版，本地 stmp 为刚刚拉取的最新 1.8.0。**

> ⚠️ **上游脚本不纳入本仓库 git**：`stmp/奥术摸鱼大师辅助-latest.js` 仅作本地对照/逆向参考，**不得 `git add`/`git push` 到本仓库**（第三方 MIT 脚本，且本仓库已实现独立功能）。本仓库 `聚合.js` 版本随自身迭代递增（当前 `@version 2.9.0`，新增赛事精准归属选图）。

**拉取命令**：
```bash
curl -sL https://reelax.hsiyue.com/arcane-assistant.user.js -o stmp/奥术摸鱼大师辅助-latest.js
```

---

## 二、上游脚本功能全貌（v1.7.1）

按模块划分（依据源码函数与配置项）：

| # | 模块 | 说明 |
|---|------|------|
| 1 | 自动切图 | 优先级 `competition→designated(指定图)→goldwind(金风)→experience(经验)→gold(金币兜底)`；支持船队模式独立优先级 `partyMapPriority` |
| 2 | 自动补杆 | 快照精确调度（`scheduleRefill`），剩余<1/2 时 `fishing.refill()` |
| 3 | **买 Buff** | `checkAndBuyBuffs()`：按天气/比赛选**商店 Buff**（遗物/碎片商店，`/api/shop/purchases`），分组 25 分钟冷却 + 服务端 activeBuffs 验算 + 余额检查。**这是「商店增益」不是公会区域增益** |
| 4 | 自动报名 | 个人赛自动报名（`autoRegisterPersonal`） |
| 5 | 每日签到 | `dailyCheckIn.claim()` + `dismissReminder` |
| 6 | 加点/比赛洗点 | `autoAllocateStats` + 比赛前洗点 `autoRespecPersonal/Guild`（`respecStrengthTarget`）、赛后分配 `applyPostRespec` |
| 7 | 装备切换 | `autoLoadout`（loadout 槽位切换） |
| 8 | 场景切饵 | `autoBait` + `baitByScene`（按天气/比赛场景）+ `baitFallback` + `baitAutoBuy` |
| 9 | 卖鱼 | `sellFishEnabled`，按稀有度+定时（默认 30 分钟） |
| 10 | 卖装备 | `sellGearEnabled`，按稀有度+品质阈值+定时 |
| 11 | 比赛蹭奖 | `dipPersonal` / `partyDipPersonal` / `witherTideDipPersonal`（枯潮首竿蹭奖）、`partyDipMinutes` |
| 12 | 每日盈亏 | 收支账本 `ledger`（截获 `/api/` 响应记流水）+ 每日余额 `balance` |
| 13 | 奇异/奥秘记录 | `catchLog` 钓获记录面板 |
| 14 | 保底显示 | `fetchPity` + 保底进度面板（纯展示） |
| 15 | 弹窗处理 | 比赛提醒、离线结算自动关闭 |
| 16 | 跟船/船队 | `autoPartyTravel`、离船归队、船员只跟船 |
| 17 | 掉竿统计 | 理论/实际杆数、掉竿统计 |
| 18 | **采集/上报** | 上报使用统计（`/usage`）、问卷（`/survey`）、错误报告（`/report`）、建议（`/suggestion`）到 `reelax.hsiyue.com`，按 uid 去重 |
| 19 | 版本检查/更新横幅 | 见上 |

> 注：以上为 1.7.1 时代已稳定的功能全貌。以下为从刚拉取的 **1.8.0** 源码中确认的相对演进（与 1.7.1 的差异点）。

### 2.1 1.8.0 相对 1.7.1 的演进（基于 1.8.0 源码核实）

| # | 演进点 | 说明（1.8.0 新增/变化） |
|---|--------|--------------------------|
| E1 | **赛事精准归属（分组）** | 赛事选图不再只看 `biomes[].activeCompetitions`，而是拦截 `/api/tournaments/overview` 与 `/api/guild-tournaments/overview`，用赛事实体的 `assignedBiomeId` 或 `groups[myGroupId\|defaultGroupId].biomeId` 解析**属于当前玩家的赛事地图**；并用 `isRegistered`/`entryStatus==='registered'` + 时间窗过滤，只去「已报名且进行中」的赛事图。两个赛事地图并存时精准去「属于我们的」那张。 |
| E2 | **切图优先级链细化** | 默认 `competition→designated(指定图)→goldwind(金风)→experience(经验)→gold(金币)→strengthluck(力运)`；新增 `designated`(手动指定图，适合刷专精)、`goldwind`(金风天气额外 300~500 金币)、`strengthluck`(力运玩家专用综合评分：图价倍率×天气加成，按天气类型加权、奥术涌流直接去最高级图)。船队模式独立 `partyMapPriority`。 |
| E3 | **世界Boss 完整模块** | `WORLD_BOSS_HUNT_HOURS=[12,20]`，自动报名 + 战前临时洗点(`autoWorldBossRespec`) + 战斗中/后切换配装(`autoWorldBossLoadout`) + 战后恢复属性(`worldBossRespecBefore/AfterMin`、`worldBossLoadoutDuring/After`)，含准备/恢复定时器与状态机。 |
| E4 | **船队增强** | `autoPartyTravel`/`partyDesignatedBiomeId` + `partyLimitByCrew`(按最低船员等级限图)；`partyDipPersonal`/`partyDipMinutes`(船队比赛蹭奖)。 |
| E5 | **赛事蹭奖细化** | `dipPersonal`/`witherTideDipPersonal`(枯潮首竿蹭奖)/`skipWitherTidePersonal`，且蹭奖前用 `getPersonalCompContext()` 校验归属(seq/biomeId)避免串赛事。 |
| E6 | **买 Buff 按天气分组** | `autoBuyBuffs` + `buffSelections` 按 `triggerWeathers`/当前天气 tab 分组勾选（遗物/碎片商店 Buff），分组 25min 冷却 + `activeBuffs` 验算 + 余额检查。 |
| E7 | **装备 loadout 进入赛事流** | `autoLoadout`：进入赛事地图自动切「比赛配装」槽位，离开切回「日常配装」；与世界Boss 配装切换共用 `switchLoadout()`。 |
| E8 | **加点目标/顺序可配** | `statAllocationTarget`(默认 intelligence)、`statAllocationOrder`、`excludeMasteryBonus`/`excludeGuildBoost`(评分时排除专精/公会增益)、赛后 `postRespecRemainderStat`/`postRespecFixed`。 |
| E9 | **卖鱼/卖装备细化** | `sellFishRarities`/`sellFishIntervalMin`、`sellGearRarities`/`sellGearQualities`(按品质阈值如 60 分以下卖)/`sellGearIntervalMin`，独立运行开关 `sellFishRunning`/`sellGearRunning`。 |
| E10 | **展示增强** | 保底进度(`fetchPity`)、理论/实际杆数(`showTheoreticalCasts`)、账本收支(`showBalance`)、装备完成度(`showGearPercent`)、奇异/奥秘记录(`catchLog`)。 |

> 说明：1.7.1 源文件未留存本地，以上「演进」是基于 1.8.0 源码结构 + 本仓库既有 1.7.1 全貌记录反推，凡 1.8.0 明确存在而 1.7.1 记录未单列的能力均列入。若后续需精确 diff，可重新拉 1.7.1 归档对照。

---

## 三、我们的扩展功能全貌（firefoxfish）

我们不是油猴脚本，而是 **Firefox 浏览器扩展**（后台 monitor.js + 页面注入聚合.js + Python 桥）。功能：

| # | 模块 | 说明 |
|---|------|------|
| 1 | 自动切图 | `聚合.js`：优先级 `赛事>跟船>雷暴/优选`；**新优选评分**（倍率×天气鱼系数 0.55/0.45）、旧算法（编号即金币）；指定图/金风/经验 |
| 2 | 自动补满杆数 | `聚合.js`：服务端快照精确调度 + DOM 兜底节流 |
| 3 | 换鱼饵 | 按优先级类型（赛事/雷暴/优选）自动切饵 |
| 4 | 每日签到 | 官方 API + DOM 兜底 |
| 5 | **自动开公会区域增益** | **独有**：由聚合优选地图通知驱动 → `guildBoostPurchase`；赛事固定 3 份/非赛事按天气折算；已有增益防多开 |
| 6 | 自动加点 | monitor：`unspentStatPoints>0` → `/api/player/stats/allocate` |
| 7 | 自动加专精 | monitor：每 10 分钟 `contribute-all` |
| 8 | 保底监控 | monitor：定时查 `/api/statistics` pity，出货/软满/逼近硬保底 **webhook 通知**（非纯展示） |
| 9 | 自动售鱼/售装备 | monitor：定时卖鱼/卖装备（稀有度/品质阈值） |
| 10 | 掉线检测/自动刷新 | monitor：心跳 + proof 验证 + 掉线刷新页面 |
| 11 | 统一 webhook 通知 | 掉线/登录失效/加点/切图/开增益通知到企微 |
| 12 | 世界Boss | 自动报名 + 弱点选择 |
| 13 | 奥术献祭 | 自动贡献（遗物/鱼/金币） |
| 14 | 比赛一键报名 | `registerAll` |
| 15 | 比赛洗点/加点 | `checkCompetitionRespec` |
| 16 | **Python 桥** | **独有**：bridge.js ↔ api.py（WS 55004），Python 下发签名请求 |
| 17 | **devtools 分析工具** | **独有**：`fish_economy.py`（收益模型/加点）、`history_economy.py`（真实收益对比）、`gear_advisor.py`（装备/升竿建议）、`guild_stats.py`（公会四维分析）、`market.py` |
| 18 | 日志收集 | 页面 console 落盘 |

---

## 四、功能对比总表

图例：✅=有且实现完整  ◐=部分/弱化  ✖=无  ⭐=我们独有优势

| 功能 | 上游 1.8.0 | 我们 firefoxfish(2.9.0) | 说明 |
|------|:--:|:--:|------|
| 自动切图 | ✅ | ✅ | 上游 1.8 优先级 `competition→designated→goldwind→experience→gold→strengthluck`(含指定图/金风/力运/经验独立项)；我们有 `赛事>跟船>雷暴/优选`+ 新优选评分 |
| 自动补杆 | ✅ | ✅ | 两者都走快照精确调度 |
| 换鱼饵 | ✅ | ✅ | 上游按场景；我们按优先级类型 |
| 每日签到 | ✅ | ✅ | 同 |
| **自动开公会区域增益** | ✖ | ✅⭐ | **我们独有**（上游只「买商店Buff」，不自动开公会区域增益） |
| **买商店 Buff** | ✅ | ✖ | 上游独有（遗物/碎片商店，按天气/比赛选）——**可考虑借鉴** |
| 自动报名 | ✅ | ✅ | 上游个人赛；我们比赛一键报名 |
| 加点 | ✅ | ✅ | 上游含洗点/赛后分配；我们普通加点 |
| 比赛洗点 | ✅ | ✅ | 双方都有 |
| 装备切换(loadout) | ✅ | ✖ | 上游独有——**可借鉴** |
| 卖鱼 | ✅ | ✅ | 同 |
| 卖装备 | ✅ | ✅ | 同（品质阈值更细） |
| 比赛蹭奖(dip) | ✅ | ✖ | 上游独有（枯潮/蹭奖首竿）——**可借鉴** |
| 每日盈亏/账本 | ✅ | ✖ | 上游独有——**可借鉴** |
| 奇异/奥秘记录 | ✅ | ✖ | 上游独有 |
| 保底显示 | ✅(纯展示) | ✅⭐(webhook通知) | 我们更进一步：主动通知出货/保底 |
| 掉竿统计 | ✅ | ✖ | 上游独有 |
| 弹窗处理 | ✅ | ✅ | 同 |
| 跟船/船队 | ✅ | ✅ | 我们含船长自动开船 |
| 掉线检测/自动刷新 | ✖ | ✅⭐ | **我们独有**（扩展后台监控） |
| proof/签名管理 | ✅ | ✅ | 都在前端截获 HMAC proof |
| **webhook 通知** | ✖ | ✅⭐ | **我们独有** |
| **Python 桥** | ✖ | ✅⭐ | **我们独有**（本地 API 分析） |
| **经济/装备分析工具** | ✖ | ✅⭐ | **我们独有**（fish_economy/gear_advisor 等） |
| 世界Boss | ✖ | ✅ | 我们独有 |
| 奥术献祭 | ✖ | ✅ | 我们独有 |
| 自动加专精 | ✖ | ✅ | 我们独有 |
| 采集/上报到第三方 | ✅ | ✖ | 上游会上报 uid/使用统计/错误到 hsiyue.com——**隐私注意点** |
| **赛事精准归属(分组)** | ✅ | ✅⭐ | 上游 1.8 用 overview 的 `assignedBiomeId`/`groups[myGroupId]` 解析归属；**我们 2.9.0 已对齐**（拦截 overview + `getCompetitionBiomeId` + 已报名过滤），且叠加独有 webhook 通知 |
| **世界Boss 完整模块** | ✅ | ◐ | 上游 1.8 含自动报名+战前洗点+战中/后配装+恢复状态机(`WORLD_BOSS_HUNT_HOURS=[12,20]`)；我们仅自动报名+弱点选择，缺洗点/配装切换 |
| **装备 loadout 切换** | ✅ | ✖ | 上游 1.8 进赛事/世界Boss 自动切比赛配装、离开切回日常；我们无——**可借鉴** |
| **比赛蹭奖(dip)** | ✅ | ✖ | 上游 1.8 含 `dipPersonal`/`witherTideDipPersonal`(枯潮首竿)/`partyDipPersonal`；我们无——**可借鉴** |
| **船队增强(限图/蹭奖)** | ✅ | ◐ | 上游 1.8 含 `partyLimitByCrew`(按最低船员等级限图)/`partyDesignatedBiomeId`；我们船长自动开船有，但无限图等级/船队蹭奖 |
| **买商店 Buff(按天气)** | ✅ | ✖ | 上游 1.8 `autoBuyBuffs`+`buffSelections` 按天气分组；我们无（我们有的是公会区域增益，二者互补）——**可借鉴** |
| **每日盈亏/账本** | ✅ | ✖ | 上游 1.8 截获 `/api/` 记流水账本；我们无——**可借鉴** |
| **奇异/奥秘记录** | ✅ | ✖ | 上游 1.8 `catchLog` 出货记录面板；我们无 |
| **掉竿统计(理论vs实际)** | ✅ | ✖ | 上游 1.8 `showTheoreticalCasts`；我们无 |
| **加点目标/顺序可配** | ✅ | ◐ | 上游 1.8 `statAllocationTarget/Order`+排除专精/公会增益评分；我们普通加点 |

---

## 五、可以借鉴/更新进我们的东西（上游有、我们无）

> 都是纯前端油猴逻辑，容易移植进我们的 `聚合.js` 或 `monitor.js`。
>
> **⚠️ 当前决定：本节整体暂不移植**（2026-08-19 评估，优先级低于我们自己扩展的现有功能与稳定运行，先搁置）。

1. **买商店 Buff（`checkAndBuyBuffs`）**
   - 按天气/比赛自动买遗物/碎片商店的 Buff（经验/力量/运气/命中），分组 25min 冷却 + activeBuffs 验算 + 余额检查。
   - 注意：这与我们「自动开公会区域增益」是**两种不同增益**，可并存、互补。
2. **装备 loadout 切换（`autoLoadout`）**
   - 比赛前/加点后自动切到指定 loadout 槽位。
3. **比赛蹭奖（dipPersonal / partyDipPersonal / witherTideDipPersonal）**
   - 个人/船队比赛首竿蹭奖、枯潮比赛蹭奖，到期自动回。
4. **每日盈亏/收支账本（ledger + balance）**
   - 截获 `/api/` 响应自动记流水，按天/周聚合，本地持久化展示。我们已捕获 fishing/sync 响应，扩展这点更稳，可扩展成账本。
5. **奇异/奥秘钓获记录（catchLog）**
   - 记录出货时间/地点/饵，本地持久化。
6. **掉竿统计（理论 vs 实际杆数）**
   - 我们 monitor 已捕获 fishing 数据，可算出掉竿率。
7. **指定图（designatedBiomeId）**
   - 手动指定某张图优先；我们 mapPriority 无此选项。
8. **「经验」独立优先级**
   - 上游把「经验最高」作为独立优先级（排除专精/公会可选）；我们是综合评分，可考虑加「纯经验优先」选项。

---

## 六、我们独有、上游没有（保持优势，别丢）

1. **自动开公会区域增益**（聚合优选地图驱动 + 已有增益防多开）——上游完全没做。
2. **后台统一在线监控**：掉线检测、proof 主动验证、登录失效自动刷新、心跳。上游只是纯前端脚本，不做后台守护。
3. **统一 webhook 通知**：切图/开增益/掉线/加点/保底出货等主动推送到企微。上游无通知。
4. **Python 桥 + devtools 分析工具集**：fish_economy（收益/加点模型）、history_economy（历史真实收益）、gear_advisor（装备/升竿建议）、guild_stats（公会四维）、market（市场）。这些是**独立的分析/决策工具**，不是游戏内自动化，上游完全没有。
5. **自动加专精、世界Boss自动报名、奥术献祭自动贡献**：上游均无。
6. **跨重启状态持久化**：我们 monitor 用 browser.storage.local 持久化保底/加点/增益历史，重启不丢；上游纯 localStorage。

---

## 七、风险与注意点

1. **上游会上报数据到第三方 `https://reelax.hsiyue.com`**（作者自己的采集/反馈服务器，非游戏官方）。**我们的扩展没有也不应有**这种上报，隐私更干净。上报详情如下：

   **公共字段（`collectBase()`，所有上报都带）**：
   - `uid`：玩家 publicId（`meData.publicIdentity.publicId`，即玩家唯一身份标识）
   - `name`：玩家昵称（`meData.player.nickname`）
   - `version`：脚本版本号（如 `1.7.1`）

   | 上报点 | 触发方式 | 附加上报内容 |
   |--------|----------|--------------|
   | **`/usage` 使用统计**（`reportUsage()`） | **自动、静默**：脚本初始化时自动触发一次，客户端每天最多一次 | 仅公共字段 `{uid, name, version}`，无额外内容 |
   | **`/survey` 问卷**（`submitSurvey()`） | 手动：用户在面板「反馈」tab 填问卷点提交 | 公共字段 + `surveyId`(`push-survey-v1`) + `answers`（问卷答案：是否需要推送、推送渠道、能否装 App、想接收哪些推送内容、推送频率、其他建议文本） |
   | **`/report` 错误报告**（`submitReport()`） | 手动：用户提交错误报告（10 分钟冷却） | 公共字段 + `desc`（用户描述） + **`settings`（完整配置 JSON：所有开关、地图优先级、指定图、鱼饵/场景、Buff 勾选、卖鱼/卖装备规则、加点目标等）** + **`logs`（日志文件 `log.txt`，最近 2000 条 `[时间][标签]消息` 的操作日志）** |
   | **`/feedback` 建议**（`submitSuggestion()`） | 手动：用户提建议（10 分钟冷却） | 公共字段 + `desc`（建议文本），**不带日志** |
   | **`/version` 版本检查**（`checkVersion()`） | 自动：初始化 + 每小时 GET | **只 GET 查询最新版本号，不上报任何数据** |

   **要点**：
   - **唯一真正“自动/静默”上报的是 `/usage`**（每天一次，仅 uid/name/version，用于按玩家统计活跃与去重）。
   - `/survey`、`/report`、`/feedback` 都是**用户手动点击**才触发；其中 `/report` 会带上**完整配置 JSON + 2000 条操作日志**，属于敏感信息（暴露用户全部自动化配置与近期行为）。
   - 上报绕过了游戏 API 拦截器（用 `originalFetch`），发往作者自己的 `hsiyue.com` 域。
   - 建议：我们扩展**完全不做**这些采集上报（既不自动 `/usage`，也不提供向第三方提交问卷/报告/建议的入口），保持零外发。
   - 若未来需要“使用统计”，也应只保留本地统计或发往用户自己可控的 webhook，绝不带 uid/日志发第三方。
2. **上游匹配 `reelax.abang666.com`**：可能是作者自己的游戏站；我们只跑官方 `reelax.cn`。
3. **上游是油猴脚本，无后台/无浏览器权限**：断线重连、自动刷新页面这类需要后台能力的，它做不了——这是我们扩展架构的天然优势。
4. **版本更新**：上游会每小时查 `/version`；我们扩展改代码靠 git + web-ext 重载，无自动更新（可控性更好）。

---

## 八、结论 / 建议动作

1. **上游已发 1.8.0**（本地 `stmp/奥术摸鱼大师辅助-latest.js` 为对照，sha256 `04bc65af...`）。1.8.0 相对旧版主要演进：赛事精准归属(分组)、切图优先级链细化(指定图/金风/力运)、世界Boss 完整模块、船队增强、赛事蹭奖细化、买 Buff 按天气分组、装备 loadout 进赛事流、加点目标可配。**上游脚本不入库、不推送**（第三方 MIT，且我们已实现独立功能）。以后可定期 `curl` 该 URL + `/version` 检查。
2. **我们已对齐「赛事精准归属」**：聚合 `2.9.0` 新增 overview 拦截 + `getCompetitionBiomeId` + 已报名过滤，解决「两个赛事地图时精准去属于我们的那张」（见 2.1 E1 / 对比表第 3 行）。
3. **第五节「可借鉴功能」整体暂不移植**（当前优先级低于我们自己扩展的稳定运行；留作 backlog，后续需要时再评估，见第五节）。其中 **装备 loadout、比赛蹭奖(dip)、买商店 Buff、每日账本** 是 1.8.0 明确具备而我们缺失、相对容易移植的优先项。
4. **我们的独特优势继续加强，不要回退**：自动开公会区域增益、后台在线监控、webhook 通知、Python 分析工具集。
5. **不建议引入**：任何向第三方上报 uid/使用统计/错误日志/完整配置的采集逻辑（详见第七节）。

## 十、新奇功能创意（发散 · 依托我们独有架构）

> 不再照搬上游。以下功能都依托我们**独有的架构能力**——后台 monitor 拦截游戏响应、Python 分析桥、webhook 通知、页面注入脚本——这些是纯前端油猴脚本做不到的。按「新奇程度 × 落地成本」排序。

### 10.1 神秘：逐杆「AI 风控」抓包级行为档案
- 我们已能拦截 fishing/sync|state 响应体。可以**每一杆**记录：时间/地图/天气/饵/当前保底计数/出货，形成「玩家完整钓鱼行为时间轴」存在本地。
- 新奇点：不只是看保底，而是**复盘「出货前 N 杆发生了什么」**——比如某次奇异出货是不是总在某种天气+某种饵+某个保底区间之后。
- 结合 Python 桥离线做**相关性分析**（不用实时），生成「出货模式画像」，下次接近该模式时 webhook 提前提醒「大概率要出货了」。

### 10.2 反直觉：异常诊断「自愈决策树」
- 我们已有掉线检测/403 自愈。可以升级成**分层自愈**：出问题时自动按决策树尝试（重试→刷页→等冷却→切备用饵→放弃该图），每一步记录原因，最后 webhook 汇报「这次异常我做了什么、为什么」。
- 新奇点：不是死等刷新，而是**像运维机器人一样自动排障**，减少无谓刷新。

### 10.3 独占：实时「挂机体检」健康分
- 后台每 N 分钟把关键指标打分：在线率/补满及时率/切图正确率/保底健康度/掉线次数/响应异常数 → 一个 0-100 健康分 + 失败项清单。
- 新奇点：像「体检报告」一样每天/每周自动 webhook 发你一份《挂机日报》，告诉你今天挂机质量如何、该调什么。

### 10.4 经济学：市场套利「盯盘机器人」
- 我们有 Python 桥 + market 工具。可以写一个**盯盘循环**：扫 `/api/market/orders` 买/卖订单，检测「跨图/跨时间套利空间」（低价收、高价挂），达阈值 webhook 提醒甚至自动挂单。
- 新奇点：把分析工具从「事后分析」变成「实时盯盘 + 套利提醒」，这是纯前端脚本做不到的（需要持续后台 + 签名写操作）。

### 10.5 情报：全服/公会「实时动态雷达」
- 后台持续抓：公会各地图人数、全服比赛动态、世界Boss阶段、奥术涌动/金风天气变化。
- 新奇点：不只给自己切图，而是**自动推送「现在全服哪里人最多/哪张图刚起奥术涌动」**，或预测「接下来哪张图会成热点」。

### 10.6 复盘：每周「收益归因分析」自动出报告
- 我们有 history_economy / fish_economy。可以每周自动汇总：这周在哪个图/哪个饵/哪个天气赚最多、掉竿损耗、保底出货价值。
- 新奇点：不只看「赚了多少」，而是**归因「钱是怎么赚的、下次该主攻哪张图」**，自动生成图文报告发你。

### 10.7 省心：船队「智能值守」（动态跟船 + 过期预警 + 自动补养）
- 我们已有船长自动开船。可扩展成**船队管家**：船租赁/保养快到期 webhook 提前预警、船长离线时自动交给副手、动态根据全队成员图决定最佳船图。

### 10.8 彩蛋：钓鱼「作息教练」
- 结合保底 + 每日时段数据，学习「我几点上货率高」，到黄金时段 webhook 提醒「现在适合全力钓」。

### 10.9 极限：一键「全自动托管」模式
- 把现有的：切图+补杆+饵+加点+专精+保底+开增益+卖鱼+卖装备+任务+成就+世界Boss+献祭……**做成一个总开关**，开启后完全无人值守，异常全自动处理，只在关键节点 webhook 汇报。
- 新奇点：不是单点功能，而是**把整个扩展升级成「挂机操作系统」**。

---

### 10.10 奇思怪想（不保证实用，纯开脑洞）
- **钓鱼玄学日历**：根据真实出货数据 + 农历/时段，生成「今日宜钓图」。
- **欧非指数**：把你的掉率 vs 全服预期掉率对比，算出你的「欧气值」，波动时提醒。
- **自动化日报语音**：webhook → 语音播报今日战果。
- **多号影子**：用一个号的经验给另一个号推荐策略（需要多号数据，属于进阶）。

### 10.11 落地优先级建议
1. **易落地、马上有收益**：10.3 挂机体检日报、10.6 每周收益归因、10.7 船队管家。
2. **中成本、新奇度高**：10.4 市场套利盯盘、10.5 全服雷达、10.1 出货模式画像。
3. **大工程、体验质变**：10.9 全自动托管总开关。

> 如果你想先做，我推荐从 **10.3 挂机体检健康分/日报** 或 **10.6 每周收益归因报告** 起步——都是我们现有数据 + webhook 就能拼出来，新奇又实用。
