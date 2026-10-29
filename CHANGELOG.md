# 更新记录

本项目变更记录。每次 Release 会同步写到此文件并打 git tag。

> 版本递增规则：破坏性修改 → MAJOR+1（高位清零）；向下兼容新功能 → MINOR+1；向下兼容 Bug 修复 → PATCH+1；升高位后低位清零。

## [v1.14.9] - 2026-10-27

### 优化：非最低价挂单列表支持全选，挂单成功自动取消勾选
- `scripts/一键市场.js`：最低价检测区标题行新增「全选」复选框（`r1cm-cheap-allsel`，绿色强调），一键勾选/取消全部**未忽略**的正常挂单（已忽略项不参与重挂），状态随列表实时同步；无正常项时禁用。
- 求购（捡漏）挂单流程：每条成功后从 `bargainState.checked` 移除该鱼并重渲染，避免下次重复发布；失败项保留勾选以便重试。

## [v1.14.8] - 2026-10-27

### 优化：自动加点读取属性失败时保守全加副属性
- `monitor.js` `autoAllocate`：主属性阈值模式下，`playerStats()` 读取当前总属性时不再把失败/缺失当作 `curTotal=0`（否则 `needToReach` 恒等于目标值，会把整批新点误加主属性——即使实际早已达标）。
- 现在仅在拿到有效数字时才计算差额；无法确认时 `toPrimary=0`、全部加副属性并输出告警，等下次巡检重试。

## [v1.14.7] - 2026-10-27

### 优化：献祭门槛设为 0 表示该资源完全不参与
- `monitor.js` `computeSacrificePlan`：门槛百分比改为——未设置/空/非数字才回退默认 0.5%；显式设为 **0 或负数则视为关闭**（返回 `null`），该资源跳过自动献祭并标记 `reason='已关闭(门槛0)'`。
- 修复此前"把门槛设成 0 想关掉某资源"却被回退成 0.5% 仍继续自动捐献的问题。

## [v1.14.6] - 2026-10-27

### 优化：经验增益选图的转生/等级可达判定
- `monitor.js`：`findBoostWeatherOptimalBiome` 可达规则改为——全船最低转生 < 地图转生要求则不可达；**转生严格大于要求时直接可达、不再校验等级**（如 1 转可去所有 0 转图）；转生恰好等于要求时仍需全船最低等级 ≥ `requiredLevel`（如 b_016 需 1 转 + 5000 级）；无转生数据时退回纯等级木桶。
- 修复上次改动导致的「转生够但等级略低就误判不可达」漏选。

## [v1.14.5] - 2026-10-27

### 优化：经验增益选图增加转生等级木桶约束
- `monitor.js`：`findBoostWeatherOptimalBiome` 判断「船可达」时，除全船最低等级 ≥ 地图 `requiredLevel` 外，新增全船最低转生轮次 ≥ `requiredReincarnationRound`（从 `/api/party-boats/overview` 的 `crew.members[].identity.reincarnationRound` 推导，未知则不加该约束）。
- 避免选中等级够但转生不足的地图（如 b_016 永烬炉海要求转生 1 阶），导致开增益后切图失败。

## [v1.14.4] - 2026-10-26

### 修复：世界Boss 属性全为 0 时误选「力量」为首选属性
- `monitor.js`：`m.sync` 通常不含 `player.stats`（来自 fishing/sync），导致属性快照全为 0；此前把「全 0」视为有效总值，`computeWorldBossBestStat` 因 `0 > -Infinity` 恒选第一个属性（力量），且该 0 快照被写入缓存后 `checkWorldBoss` 永远走「已有值」分支、从不回查 `/api/player/stats`。
- 修复：`worldBossPlayerSnapshot` 全 0 时返回 `null` 且不缓存；`worldBossPlayerTotals` 全 0 时置 `null`；`computeWorldBossBestStat` 的 `haveTotals` 改为要求至少一个属性 > 0；`checkWorldBoss` 改为 `snap` 为空或 base 全 0 时回查 `/api/player/stats`，并以回查结果为准。
- 另：`refreshWorldBossPlayerSnapshot` 写 `m.sync.unspentStatPoints` 前判空 `m.sync`，避免 null 异常。

## [v1.14.3] - 2026-10-26

### 优化：勾选框与文字对齐
- `scripts/一键市场.js`：捡漏品级勾选（`data-rar`）改为 14×14 固定尺寸、`margin:0`，容器与文字统一 18px 行高，消除勾选框撑高与文字上下错位。
- `scripts/保底显示.js`：buff 选项（`data-buff`，18px 行高）与启用天气（`data-weather`，16px 行高）同样改为 14×14 固定尺寸 + 统一行高，勾选列表不再错行。

## [v1.14.2] - 2026-10-26

### 清理：移除遗留采集文件
- 删除 `devtools/_biomes_tmp.json`、`devtools/_mastery_b009.json`（v1.0.0 起误入库的调试采集产物，无任何代码引用），减小发布包体积。

## [v1.14.1] - 2026-10-26

### 优化：捡漏专精等级本地秒读，且专精/等级/已求三路数据各自独立渲染
- `scripts/一键市场.js`：新增专精等级持久化（`r1cm-mastery-level`，含 `ts` 时效，遵循 `MASTERY_CACHE_TTL`）。`masteryLevelMap` 拉取成功后写入本地；拉取失败时本会话缓存 → 本地持久化缓存依次兜底。修复「LV 显示很慢 / 需关窗重开才显示」。
- 扫描与「恢复上次扫描」两条路径中，专精集合（`*`）、专精等级（`LV`）、我的求购（已求）由原来的 `Promise.all` 合并等待改为**各自独立异步刷新与重渲染**，谁先返回谁先显示，避免 LV / 已求被最慢的请求拖住、或求购单返回后不刷新。
- 仅「只拉专精鱼」时仍阻塞等待这三路数据（筛选所必需）。

## [v1.14.0] - 2026-10-26

### 新增：一键市场挂单页签按地图筛选
- `scripts/一键市场.js`：挂单页签新增「地图（仅挂所选地图的鱼）」下拉（`r1cm-biome`），默认「全部地图」；选中后仅对 `parseFishId().biomeId` 匹配的鱼挂单，选择随 `localStorage` 持久化（`biome` 字段），并在运行日志中标注本次筛选用到的地图。

### 优化：世界Boss「全洗弱点」改为按洗点后各属性实际伤害择优
- `monitor.js`：`computeWorldBossAllIn` 口径升级——不再是"全投弱点 vs 当前最优"的二元判定，而是把洗点后可支配池（`unspent + Σbase`，扣除耐力预留）**分别全投到每个勾选属性**，算出各自洗后总属性×倍率（弱点×2.0 / 普通×1.0 / 防御×0.5）的实际伤害，取伤害最高者作为报名与开战全投目标（`regStat`）。平局按 力量>智力>运气>耐力 顺序。
- 因此洗点后最优**可能不是弱点**（`isWeakWin=false` 时仍按洗后最优属性报名/洗点），仅当该最优属在用户勾选白名单内才武装；未勾选任何属性时不参与洗点计算（`respecBlocked` 判定同步收紧为需已勾选属性）。
- `armWorldBossRefill(w, target)` / `autoWorldBossRespecTick` 改为全投 `regStat`（新增 `target` 字段，`weak` 仅作展示参考）；日志与 webhook 文案改为展示"洗点后最优属性 + 洗后/不洗伤害对比 + 各属性全投伤害表"。
- `options.html` / `popup.js`：说明与面板文案同步（"先算各属性全投实际伤害，取最高属性报名"；显示 `洗后X=弱点/≠弱点`）。

### 新增：支持 b_016 永烬炉海 / b_017 回环岁海 两张新地图
- `scripts/聚合.js`：BIOME 名称表补 `b_016`/`b_017`；地图倍率注释更新为 `1+0.05×序号`（b_017=1.85），明确倍率只与序号线性相关、与转生门槛无关。
- `popup.js` / `monitor.js`：`AB_BIOME_CN`、`CURRENT_STATUS_BIOME_CN` 补两张地图中文名。
- `scripts/一键市场.js` / `scripts/以物易物价格.js`：`HARD_FISH` 各补 132 条（b_016/b_017 各 66 种），两份表校验完全一致（共 1122 条）。

### 其它
- 去除本轮被编辑器写入的 UTF-8 BOM（`monitor.js`、`popup.js`、`scripts/聚合.js`、`scripts/一键市场.js`、`scripts/以物易物价格.js`），保持仓库统一无 BOM。

## [v1.13.1] - 2026-10-23

### 修复：buff 天气判定在 fishing/state 403 时整体失效（含勾选的奥秘涌流也不买）
- `scripts/保底显示.js`：`fetchActiveBuffs` 不再因 `/api/fishing/state` 返回 403 而直接放弃。该接口失败时改用游戏内存快照 `getSnapshot().biomes[]` 中 `isCurrent` 图的 `weather`（实测字段 `id` + `endsAt`）判定当前天气；已生效 buff 亦从快照兜底，避免重复购买。签名接口失败仅告警不阻断。
- `manifest.json`：1.13.0 → 1.13.1。

## [v1.13.0] - 2026-10-22

### 新增：商店 buff 按「启用天气」自动购买（可多选天气）
- `scripts/保底显示.js`：原「仅在奥秘涌流时购买」单选框改为**天气多选白名单**，可勾选全部 9 种天气（晴朗/雨幕/强风/浓雾/热浪/雷暴/枯潮/金风/奥秘涌流），默认勾选「奥秘涌流」。
- 行为判定：`buffTick` 每次拉取 `/api/fishing/state` 取涌流、并从地图数据取普通天气，决定是否购买——**当前天气命中勾选才买；全部不勾 = 任何天气都不买**（旧版"不勾 = 全买"行为取消）。
- 修复：普通天气（如雷暴）不购买。原实现从 `/api/fishing/state` 读 `biome.weather`，但该接口不含地图天气（仅含 `arcaneSacrifice.surge`），导致除涌流外永远判定"当前天气未知"而不买。改为：涌流仍读 `arcaneSacrifice.surge`；普通天气优先读游戏内存快照 `getSnapshot().biomes[]` 中 `isCurrent` 图的 `weather`（零请求），无快照时再请求 `/api/biomes` 兜底。
- 修复：`/api/fishing/state` 返回 403（签名失效）时整体放弃导致**连勾选的奥秘涌流也不买**。改为该接口失败不中止：天气改从内存快照 `biomes[].weather` 读取（实测字段为 `id`+`endsAt`，可正常判定），已生效 buff 也尽量从快照兜底。
- 命中后沿用原剩余时间门槛：遗物 buff 需当前天气剩余 ≥ 20 分钟，碎片 buff 需 ≥ 90 分钟。
- 配置迁移：旧 `surgeOnly === true` 自动迁移为天气白名单 `['arcane_surge']`；存储字段 `surgeOnly` → `weathers`。
- `manifest.json`：1.12.2 → 1.13.0。

## [v1.12.2] - 2026-10-16

### 优化：以物易物价格 改为硬编码鱼种表（零请求查价）
- `scripts/以物易物价格.js`：名称→fishId 映射改为与「一键市场」同源的 `HARD_FISH` 硬编码表（990 种，15 图×9 稀有度），不再每次「更新价格」拉 `/api/biomes` + 逐图 `/api/fishpedia`（15 图串行易触发限流、`fishpediaFails` 高达 5~12 导致名字表残缺、报「未匹配到鱼」）。查价零网络开销，与一键市场.js 数据保持一致，游戏更新鱼种时两处需同步。
- 修正该文件被编辑器写入的 UTF-8 BOM，与仓库其它文件保持无 BOM 一致。

### 优化：公会税率设置区随开关显隐
- `scripts/聚合.js`：公会税率设置区块 `ramp-section-guildtax` 随 `autoGuildTax` 开/关自动显示/隐藏，关闭时不再占位。

## [v1.12.1] - 2026-10-16

### 修复：公会税率设置失败不再误置「已开启」标记
- `scripts/聚合.js`：`applyGuildTaxDom` 改为仅在**真正设置成功**时才写入 `_guildTaxWindowKey`/`guildTaxSetDate` 并 `saveState`；失败则不置标记、下轮轮询重试。修复此前"标记已开但实际没设上"导致当天税率被永久跳过（漏开）的问题。

## [v1.12.0] - 2026-10-16

### 新增：世界Boss「全洗弱点」自动洗点
- `monitor.js`：`worldBossRespec`（默认关）开启后，若「重置后全投 Boss 弱点」的期望伤害**严格大于**当前伤害最大化最优期望，则报名弱点并在 `battleAt` 开战时真实洗点到弱点（`reset→读 unspent→plan→allocate`，尊重耐力预留、计入 flat 装备/遗物加成×2.0），Boss 结束后经 `executeCompEnd` 复原为原方案。
- 三段生命周期状态机（武装→洗点→复原）+ 与比赛洗点**互斥接管**（比赛进行中让位）+ 复用 `pityTriggerRelease`/`pauseBuiltinAllocate` 接管机制；跨刷新状态兜底重置。
- 属性白名单 `worldBossRespecStats`（四属性多选，默认全选）：仅当弱点属勾选属性才触发，全不勾=永不触发（未勾选时 popup 提示「弱点未勾选」拦截状态）。
- `popup.js`：世界Boss 面板显示全洗弱点状态（待洗/已洗✅/复原⏳/被白名单跳过）。
- `options.html`/`options.js`：新增「世界Boss全洗弱点」开关与弱点属性多选。
- `CONTEXT.md`：新增「世界Boss·洗点」域模型子上下文（weaknessStat/allInWeakness/strictBeat/respecTakeover/restorePlan/exclusiveTakeover）。

### 新增：公会税率按时段自动开启
- `scripts/聚合.js`：`autoGuildTax`（默认关）开启后，在每个轮询周期校准时段，在 `guildTaxStart`/`guildTaxEnd`（默认 20:00–22:00）内把公会税率自动设为 `guildTaxRate`（默认 5）。
- 税率输入框采用「配置选择器覆盖 + 模糊文本命中（邻近含"税"评分最高）」定位，`setNativeValue` 走 React 受控组件真实输入事件；`guildTaxSetDate` 持久化跨刷新记住"当天已设"，避免重复点击；当天窗口用 `_guildTaxWindowKey` 去重。新增 `guildtax` 折叠区与相关设置持久化。

## [v1.11.8] - 2026-10-15

### 优化：交换填单助手·跨图组单跨度规则统一/收紧
- `scripts/交换填单助手.js`：`maxMapDrop` 语义改为**对称跨图跨度 span**——单内任意「给图 - 收图」满足 `|给图 - 收图| ≤ span`；`span=0` 严格同图换同图，`span=N` 最多跨 N 张。注释同步更新。
- 组单边界修正：想收下限取「最高给图 - min(span, 游戏硬规则 3)」更严者；想收上限 `minGive + span`（此前无上限，可能收得比最低给图高太多）。
- **兜底（梯度破例阶段）同样遵守跨度**：单内给鱼图号差 ≤ span，`elig` 过滤增加 `rank ≤ wantHi` 上限，避免破例阶段大幅跨图（清背包优先但不再超跨度过远）。

## [v1.11.7] - 2026-10-15

### 优化：交换填单助手·发布配置跨刷新持久化
- `scripts/交换填单助手.js`：新增 `localStorage` 持久化（`rh_cfg_v1`），自动保存/恢复发布规则 CFG 字段（稀有度映射、自动循环开关、每轮订单数、先下架、单图掉落上限、每鱼保留数、循环间隔、发布/限速延迟、想收/提供类型与数量配置等）。
- 面板初始化时回填表单（进度条是否最大、循环卡片显示、下拉/复选框状态）；用 `change` 事件委托覆盖所有 `rh-*` 输入自动保存，跨刷新保留发布规则，无需每次重设。

## [v1.11.6] - 2026-10-15

### 优化：交换填单助手·自动跳转发布交换页 + 落地自动续跑
- `scripts/交换填单助手.js`：点「生成预览 / 开始」时若不在「以物易物」发布交换页（`/market?market=barter&panel=listing`），**自动跳转**到该页，并用 `sessionStorage` 记录待办意图（`preview`/`start-once`/`start-loop`）。
- 落地后脚本重注入时自动续跑原点击的操作——等待表单 DOM 稳定后直接对真实按钮下发 DOM click，与用户手点路径完全一致；`start-loop` 会同时恢复自动循环勾选。替代原「请手动切换到以物易物界面」的人工提示。

## [v1.11.5] - 2026-10-13

### 优化：一键市场·捡漏扫描专精/等级/已求数据后台并行补齐
- `scripts/一键市场.js`：鱼种硬编码后，捡漏扫描**不再串行阻塞等待 `/api/mastery`×2 与 `/api/market/my-orders` 三个网络请求**——改用**本地持久化专精集合先秒出 `*` 标记**，三个请求全放后台并行补齐后重渲染（仅刷新 `*`/LV/已求标记，不影响扫描本身）。
- 仅在**勾选「仅拉取专精鱼」**时才需先等专精数据到位以筛出目标；普通扫描立即本地开始。修复了原文 `onlyMastery` 分支引用了未定义的 `mm` 的问题。

## [v1.11.4] - 2026-10-13

### 优化：一键市场·鱼种改为硬编码表（不再每次拉 fishpedia）
- `scripts/一键市场.js`：`ensureAllFish()` **不再每次调 `/api/fishpedia`**——鱼种已硬编码为 `const HARD_FISH`（共 **990** 项 `[fishId, name]`，覆盖 b_001–b_015 × 9 稀有度）：捡漏扫鱼因此**不发任何 HTTP 请求、面板秒出**，并修复此前每次拉 fishpedia 因瞬时失败导致品种漏采的 bug（如奥秘仅显示 ~40 种）。`biomeId`/`rarity`/`mapTag` 由 `parseFishId` 从 `fishId` 推导。
- `devtools/collect_fish.py`（新增）：采集脚本，经 WS 桥签名请求 `/api/fishpedia` 生成 `HARD_FISH` 数组（`-o` 可直接写文件），供游戏新增/改名/删除鱼种时重新生成整表。
- `SKILL.md`：新增「一键市场.js 的鱼种硬编码表（HARD_FISH）」维护说明与重生成步骤；注明鱼种数据必须来自 `/api/fishpedia` 采集、禁止占位臆造（记录曾误植 b_020/秘海 示例被 990 项真实数据覆盖的教训）。

## [v1.11.3] - 2026-10-13

### 优化：一键市场·捡漏恢复提速与网络失败兜底
- `scripts/一键市场.js`：**专精鱼集合 localStorage 持久化**（30 分钟 TTL）。捡漏恢复时本地秒读（`loadMasteryIds`），不必再等 `/api/mastery` 网络往返；该接口暂不可用时也不会丢失「专精鱼 *」标记（沿用持久化集合代替空集合，避免误报"该条件下没有专精鱼"）。
- `scripts/一键市场.js`：**我的求购单拉取失败返回 `null`**（原为空集合），调用方据此区分「确实没有求购单」与「网络/超时失败」，避免用空集合把已持久化的「已求」标记误清空。
- `scripts/一键市场.js`：**报价失败/暂无盘口的鱼类目不再丢弃**——这类鱼仍来自 fishpedia、是合法鱼种（可能只是限流或暂无在售），改为保留条目并按「无数据」显示价格，避免物种数静默变少。
- `scripts/一键市场.js`：**捡漏恢复先渲染后补数据**——`saveBargainCache` 额外持久化扫描当次的「我的求购」集合；恢复时先用本地持久化专精集合 + 已求集合**秒出列表**，后台异步补齐专精等级/求购等最新数据后再重渲染一次，不阻塞显示。

## [v1.11.2] - 2026-10-13

### 修复：官方航线关闭时不再调用副作用预取接口
- `scripts/聚合.js`：`prefetchOfficialRoute` 在 `state.useOfficialRoute` 关闭时直接置空 `officialRoute` 返回，**不再调用 `routeAssistant.travel()`**。该接口是真正会执行换图的副作用操作，官方航线关闭时若仍每轮调用，会让服务端把玩家拉回其规划图（如 b_004），与脚本自身选图竞争，导致切图确认失败。
- `scripts/聚合.js`：`[AutoMap][diag]` 诊断日志增加船队当前所在图输出（`boat=…`/单人），便于排查选图决策。

## [v1.11.1] - 2026-10-13

### 修复：跟随船切图等待确认超时过短
- `scripts/聚合.js`：`mode === 'party'`（跟随船）时切图成功后等待确认成功的轮询超时由 `6000ms` 放宽到 `15000ms`。跟船模式下服务端返回确认状态更慢，原超时可能误判切图失败。

## [v1.11.0] - 2026-10-13

### 增强：聚合脚本「金风地图」优先级 + 接船模式经验优选锁定 + 移除计地图号位
- `scripts/聚合.js`：**新增「金风地图」优先级**（`goldwind`）——映射 `gilded_current` 天气，作为独立优先级项插入 UI 列表可排序，旧算法也保留 `tempest` 雷暴不变；新算法优先级链 = 赛事>跟班>官方>金风>优选>经验。
- `scripts/聚合.js`：**接船模式（船长/徒手 + 自动开船）经验优选锁定**：
  - 新增 `expSettingsLocked()`——船长或徒手且开着自动开船时为真，此时「经验优选·计入船队加成」与「经验优选·贪婪模式」两开关置灰禁用（点击也不再生效），避免与【船可达 + 天气经验最大 + 同分选编号最大】的接船选图逻辑冲突。
  - `pickExperience`：船可达过滤由此前仅贪婪模式扩展到「贪婪模式 或 自动开船且为船长/徒手」；同为经验倍率同分时，接船场景改为选地图编号最大的图（金币产出门槛更高）。
  - 优先级循环里自动跳过 `followboat`（接船时自己就是船，无跟随意义）；`renderPriorityList` 同步隐藏「跟随船」项且不占序号。
- `scripts/聚合.js`：**移除「经验优选·计地图号位」**开关（`expPriorityIncludeMapLevel`，此前默认关、无官方明确字段），清理其 UI 行、状态、评分加权与评分明细项。

## [v1.10.0] - 2026-10-13

### 增强：装备市集监控（gear watch）抓取优化 + 详情直达购买链接
- `monitor.js`：`checkGearWatch` 抓取由「按品级分组翻页拉整个市场」重构为「按品级 × 部位 × 价格档」分组：
  - **部位下推**：需求单恰好指定单一部位时，服务端下推 `slot`，只抓该部位卖单（如 exotic·戒指），数据量最小；多重/不限部位仍按整品级抓取、本地筛部位。
  - **价格档拆分**：同一抓取桶内只要有一条不限价需求单，就会从最便宜翻到最贵，低价单超过页数上限(50×100=5000)时会窗口截断、售价接近上限的目标永不命中；故拆「限价桶」用服务端 `maxPrice` 下推保证窗口命中，与「不限价桶」分开。
  - **品级收窄**：只为配置里实际出现的品级建桶，绝不触碰未配置品级。
- `monitor.js`：装备详情文本末尾追加 `[点击查看购买](https://reelax.cn/market?gearRarities=…&gearSlot=…&gearSort=price&market=gear)` 直达市场该部位/品级按价格排序的购买链接。
- `fetchAllGearWatchOrders`：请求参数新增 `slot`（配合部位下推）。

## [v1.9.0] - 2026-10-12

### 新增：合并独立油猴脚本「交换填单助手」（鱼换鱼交换单自动发布，自动循环版）
- `scripts/交换填单助手.js`：**由外部独立油猴脚本「发布交换单脚本」v1.0.8 整体并入扩展注入脚本库**。功能：跨图配单自动发布交换单——汇总全部地图「专精缺口」（想要池）与「多余鱼」（提供池）跨图组单，每单尽量填满 5 收 + 5 给；给鱼规则 = 想收 N 图时可给图号 ≤ N+3（高图鱼最多下降 3 张图）且单内任意一对收/给满足跨度；数量写入后自动回读校验（不匹配则重试/放弃本单，防托管超持有数无法发布）；面板预览仿游戏换鱼弹窗格式；支持自动循环（默认 20 分钟）下架旧单→缓冲→发布新单。
- 注入注册：加入 `injector.js` 的 `ALL_SCRIPTS`（可选脚本，默认开启，与一键市场等并列）；`options.js` 新增 `交换填单助手.js` 开关（默认勾选）与 `enabledScripts` 缺省项。
- 依赖：数据层走 `window.arcaneReelax.inventory.getFish()`，交易操作为 DOM 驱动，发布前带倒计时可取消，最终由游戏服务端校验。

## [v1.7.5] - 2026-10-10

## [v1.8.1] - 2026-10-11

### 增强：等级提升持久化，重启后保留上次记录的昨日/今日提升值
- `monitor.js`：`reelax_level_history` 现一并持久化最后计算的 `computedDate`/`yesterdayGain`/`todayGain` 快照；`loadLevelStats()` 重启后立即回填 `m.sync`，弹窗无需等下一次 sync 即有昨日/今日提升值；已跨天（SW 休眠跨越次日）时重算昨日提升，避免沿用旧日快照。

## [v1.8.0] - 2026-10-11

### 新增：每日等级提升追踪（昨日提升 / 今日提升）
- `monitor.js`：新增每日等级历史记录，惰性跨天检测（无需准点 00:00，每次 `fishing/sync` 拿到当前等级时比对北京时间日期；跨天自动把上一日最新观测等级固化为「昨日基准」并初始化「今日基准」）：
  - `recordLevelGain()`：维护 `byDate`（逐日 00:00 基准等级）+ 昨日基准 + 今日基准；
  - 「昨日提升等级」= 今日基准 − 昨日基准；「今日提升等级」= 当前等级 − 今日基准；
  - 结果回填 `m.sync`（`yesterdayLevelGain` / `todayLevelGain` / `levelBaseToday`），持久化 `reelax_level_history`（SW 重启不丢），并经 `pushLevelStats()` 推桥写 `data/level_history.json`。
- `bridge.js`：透传 `level-history` 消息到桥。
- `devtools/ws_bridge.py`：新增 `level-history` 处理，写 `data/level_history.json`（原子替换）。
- `gaming/daily_report.py`：读取 `level_history.json`，`report.levelProgression` 输出 `{date, currentLevel, yesterdayGain, todayGain, byDate}`；`webhookText` 增加「等级：当前 Lv… · 昨日 +N 级 · 今日 +N 级」行（扩展未推时优雅降级不展示）。
- `popup.html` / `popup.js`：「游戏状态」→「升级进度」下方新增「昨日提升 / 今日提升」两行，分别展示 `+N 级`。

### Bug 修复：日报「上钩净赚/今日累计」因 sync-hook 捕获冻结长期不准
- `scripts/日报采集.js`：游戏改走 `window.arcaneReelax`（内存缓存）后，前端不再频繁 `window.fetch` 请求 `/api/fishing/sync|state`，被 sync-hook 捕获的 `dailyHarvest`（当日总杆数 / 上钩净赚）会**冻结在启动时的小值**（如初始几百杆），导致日报「上钩·净赚」长期不准。
- 修复：新增 `refreshDailyHarvest()`，**每 300s 定时签名 GET `/api/fishing/state` 刷新 dailyHarvest**（带节流锁 `reelax_daily_dh_lock` 防并发），并写回今日档 / 推送桥。tick 里**优先采用 300s 内新鲜的 `dhCache`**；sync-hook 仅作兜底，且只有比 dhCache **更新（数值更大）** 时才覆盖，避免旧值回退。

### Bug 修复：在线率误按「24h 全天在场」打分
- `gaming/daily_report.py`：在线率期望缺省从「24h × 90%」改为优先取显式 `expectedActiveSec`；缺省改用「本日累计会话时长（activeSec+offlineSec）」，即整段挂机都保持在线即为满分，不再因早上在线 8h 却按全天 19.44h 期望被误扣为低分。

## [v1.7.4] - 2026-10-10

### 移除：游戏 API 403 后失效的 HTTP 直调回退路径
- `scripts/聚合.js`：游戏端拒绝（403）旧的直连 HTTP 读取（`signedGet`/`apiWithTimeout` 拿 `/api/fishing/state`、`/api/party-boats/overview`、`/api/biomes` 等），原「快照失败→API 直调」回退分支已全部失效且会持续撞 403。现**直接移除整条回退**，全面改走游戏 API `getSnapshot()`（零 HTTP 内存快照）。
  - 公会图腾 / 全局 buff / 智力 / 船队加成等（旧逻辑靠 403 的签名 HTTP 补充）改为缺省按 0——它们均为「全局或与地图无关」项，不影响地图间排序；有旧缓存则沿用（`_pbMaxPartyBonus`）。
  - `fetchAllData`：`gameApiReady=false` 时直接抛「游戏 API 未就绪」由轮询重试，绝不再发注定 403 的 HTTP。

### Bug 修复：硬刷新/SPA 水合导致 initGameApi 卡住、面板永不恢复
- `scripts/聚合.js`：此前 `await initGameApi()` 在硬刷新/游戏 SPA 重新水合时可能因 `await gameApi.ready` 迟迟不 resolve，导致 `createUI` 永不执行、面板停在上次遗留的灰色 idle 且永不恢复。现改为先 `createUI()` 渲染面板并启动轮询，同时**不阻塞**地后台 `initGameApi()`。

### Bug 修复：消除 createUI 首检与 initGameApi 的启动竞态
- `scripts/聚合.js`：`createUI` 首检可能早于 `state.gameApi` 赋值，`fetchAllData` 现先做**有界等待**（`gameApiBoot` Promise，超时 15s），再等 `gameApi.getSnapshot()` 就绪，避免首轮因「未就绪」误失败。API 就绪后重排轮询为「游戏 API 可用时的最优间隔」并立即补检一次。

### 改进：自动切换关闭时仍维持巡检
- `scripts/聚合.js`：开关只控制「是否真正切图/开增益/换饵/开船」，**轮询巡检始终运行**（周期刷新地图数据供面板展示，拉取最新前端版本号）。`checkAndSwitch` 在 `autoSwitch=false` 时仅更新数据/计数、记录 `lastCheckStatus` 并贴「仅巡检」原因，不发任何有副作用的动作。切换间隔、页面回到可见、首查照常触发。

## [v1.7.3] - 2026-10-08

### Bug 修复：后台标签页定时器被节流冻结导致长时间不切图
- `scripts/聚合.js`：浏览器会节流/冻结后台标签页的定时器，导致标签页切到后台后选图主循环停摆、长久不切图（休眠期日志全停）。现在监听 `visibilitychange` / `focus` / `pageshow`，**页面重新可见时立即快速补检**一次（`requestCheck({ fast:true })`，自带防并发），唤醒后尽快回到正常选图，避免「很久不切、异常 idle」。

## [v1.7.2] - 2026-10-07

### Bug 修复：达到「市场活动订单数量上限」时不再继续无效挂单
- `scripts/一键市场.js`：批量挂单循环中，当服务端返回「已达到市场活动订单数量上限」时，**立即终止本轮挂单**（`capacityHit` 提前 `break`），避免明知会被拒仍逐条发请求浪费频率预算；完成日志末追加「已达市场活动订单数量上限，提前终止」提示。本地计数/配置失效（含把装备等其它类型单占用的上限）时也能体现。

## [v1.7.1] - 2026-10-06

### Bug 修复：每 5 分钟巡检补开增益前缺少「经验最优图」校验
- `monitor.js`：巡检逻辑此前只在「当前图已有增益」「天气剩余不足 1 份」时才拦；现在在补开前**新增「当前图 = 纯天气倍率最大的船可达最远图（经验最优口径）」校验**，非最优图（如只是雨幕所在的普通图）不浪费增益。该校验与 `handleAutoBoost` 经验优选开增益的空（`findBoostWeatherOptimalBiome`）**口径一致**；取数失败则不拦截（不误拦）。配套把未触发原因 `weather-not-optimal` 记入历史便于排查。

### Bug 修复：赛事图快照兜底路径候选为空时误判赛事图
- `scripts/聚合.js`：`pickCompetition` 快照兜底路径（基于 `biomes[].activeCompetitions`）当候选为空（当前不在任何比赛时间窗）时，此前未判空会继续往下读 `candidates[0].activeCompetitions` 而误判；现 `if (!best) return null`，交由后续优先级（跟随船/经验/优选）正常处理，避免异航/不跟船。

## [v1.7.0] - 2026-10-06

### 新增：非最低价/非最高价挂单默认勾选改为「分档阈值内才勾选」
- `scripts/一键市场.js`：原「非最低价/非最高价挂单扫描后**默认全选**」（一键重挂/下架会连带操作差距过大的单）改为**按差距比例分档默认勾选**：
  - 每条挂单新增 `gapRatio`（`(挂价 − 市场最优价) / 市场最优价`）。
  - 仅当 `gapRatio <= gapThreshold(price)`（沿用已有的分档阈值）时默认勾选；差距超出阈值的不勾选，避免误操作差距过大的挂单。
  - 检查与最高价检测（`_nonMax` / `_nonMin` 两条路径）同步一致。

## [v1.6.0] - 2026-10-06

### 新增：最低价清单「永久忽略」与忽略分组收起
- `scripts/一键市场.js`：非最低价挂单列表支持**永久忽略**（`_permIgnored`，跨会话保存 `savePermIgnored`）、**行内跳转链接**（点鱼名跳到市场查看）、被忽略项统一**归到最下方分组**展示（显示折叠计数），不再与正常挂单混排。
- 忽略/取消忽略、永久忽略/取消永久忽略语义拆开：永久忽略项只显示「取消永久忽略」，不再显示临时忽略入口，避免误导。

### 新增：最低价检测按钮支持「一键下架勾选」
- `scripts/一键市场.js`：`最低价检测` 按钮扫描出非最低价挂单后**自动切换为「一键下架勾选」**（`setCheapMode`），点击批量下架勾选的卖单（只撤单、不重挂，含限流退避重试）；下架完成后按钮自动切回「最低价检测」。
- 原「勾选重挂（按设置挂单）」按钮与逻辑保留（改为 `r1cm-relist` id），重挂成功后从清单移除，不刷日志只更新状态行。

### 改进：扫描/处理进度走独立状态行，日志不再刷屏
- `scripts/一键市场.js`：新增 `r1cm-status` 状态行（列表上方），扫描与重挂/下架过程实时显示进度（N/M、成功/失败/跳过），替代原先逐条 `log` 刷日志流；日志区只在真正需要记录异常/结果时追加。

### 修复：日志 `innerHTML` 整体重绘丢失动态节点
- `scripts/一键市场.js`：`log()` 由 `innerHTML +=` 改为 **`appendChild` 追加单条**，避免整体重写 DOM 时销毁 `r1cm-cheap-region` 等动态追加进日志盒的节点及其事件委托。

### 修复：按钮重挂/下架后保持滚动位置
- `scripts/一键市场.js`：勾选/忽略/下架后不再强制滚动到列表底部，避免用户反复上下拉。

## [v1.5.2] - 2026-10-06

### Bug 修复：装备初始价把纯数字「卖家名」误判为售价
- `scripts/装备初始价显示.js`：市场卡片的**售价提取**由"整卡扫描最大 ≥10万 数字"改为**优先精确定位 footer 内带硬币图标的售价 `<strong>`**（如 `<footer class="market-gear-card-footer"><strong>…coins…100,000,000</strong>`），拿不到 footer 时才回退原扫描逻辑。
- 原因：当卖家名是纯数字（如 `<span class="market-gear-owner">122333</span>`）且 ≥100000 时，原整卡扫描会把它误判为售价，导致初始价 = 122333 − 强化累计 = 巨大负值（如 `-13,563,214`）。
- 附带：回退扫描里也显式排除 `.market-gear-owner`，双重防误判。修复后示例应显示 `+86,314,453`（卖价 1 亿 − 奇异+4 强化累计 13,685,547）。

### Bug 修复：同一装备卡出现两个「初始价」标签、等级波动为 +0
- `scripts/装备初始价显示.js`：市场卡片渲染宿主**不稳定**（`findCardContainer` 可能返回 `.gear-item-heading`/`<footer>` 等子容器，而非最外层 `<article>`），导致：子容器无 `h2.rarity-text` → 强化等级读不到而按 +0 计（footer 出现 `强化累计 0` 绿标）；且不同子容器各自渲染、清理互不作用，同一装备卡上两个标签长期共存。
- 修复：新增 `normalizeCardHost()` 将卡片宿主统一归一化到最外层 `<article>`（`.gear-item`/`.market-trade-gear-card` 等）；`findCardContainer` 与 `renderCard` 均先归一化再用。此后升级等级稳定读取 `h2 > small +N`，且同一张卡只保留一个初始价标签（重渲染会先清掉该卡全部旧标签）。

### Bug 修复：赛后误判「赛事图」导致异航（不跟船）
- `scripts/聚合.js`：`pickCompetition` 的**快照兜底路径**（基于 `biomes[].activeCompetitions`）此前只认「有 activeCompetitions」而**未按每日比赛时间窗过滤**（个人赛 10-11/15-16 点、公会赛 20-21 点，北京）。比赛结束后旧赛事实体仍挂在图快照上 → 深夜还会被误判为「赛事图」；又因 `赛事` 在优先级链中排第一顺位，把 `跟随船/经验/优选` 全部短路，导致玩家的船开到赛事图时而本人却没跟上（异航、不跟船）。
- 修复：兜底路径在选择候选赛事图前，**按每个赛事的 kind 对应比赛时间窗过滤**（`_bjInCompWindow(kind)`，非 guild 一律按 personal 时段判定）。非赛事时段即使快照残留 activeCompetitions 也不再认定该图为赛事图，从而正确落到后续优先级（跟随船等）。精准归属路径本就带时间窗判定，现两路径语义对齐。

### 行为调整：船长/舵手整船选图固定为「赛事 → 官方推荐」
- `scripts/聚合.js`：船长/舵手的**自动开船目标**由「完整优先级链（赛事/经验/优选/官方…）」改为固定两级——**有比赛（个人/公会赛）整船去赛事图；无比赛整船去官方推荐图**；**经验优选/新优选不再作为船长/舵手的整船目标**。
- 官方推荐**不依赖「官方航线」开关（`useOfficialRoute`）**：只要服务端 `routeAssistant.travel()` 给了 `targetBiomeId` 就作为目标（读 `pickOfficialRoute`，其本身不受 useOfficialRoute 限制）。与前述补丁联动：深夜无赛事时 `pickCompetition` 返回 null，天然落到官方推荐。
- 船员行为不变（仍为「赛事 → 跟随船」）；`pickBestIgnoringBoat()` 仍仅用于船员分支的「船图 vs 最优图」加成对比展示，不参与实际移动。

### 调整：赛事进场预热从「提前 5 分钟」改为「提前 2 分钟」
- `scripts/聚合.js`：赛事地图的进场预热由**开始前 5 分钟**缩为**开始前 2 分钟**，两处同步修改——`_bjInCompWindow` 的进入时间窗（聚合.js `w[0] - 2`）与 `getActiveCompetitionTargets` 的「已报名且进行中」判定（`now >= s - 2*60*1000`），避免两路径判定割裂。
- 进场：个人赛 09:58 / 14:58、公会赛 19:58（北京）起判定为赛事时段；**退出仍在比赛结束整点（11/16/21 点）起**，不受影响。
- 说明：如嫌到图缓冲不足，可按需调大（改回 3~5 分钟给切图留缓冲更稳妥）。

### 新增：赛事进/退判定用「服务器时钟校准」（防本地时钟漂移）
- `scripts/聚合.js`：赛事进出场的时刻判定由**纯本地时钟**改为**服务器时间校准后**进行，避免本地时钟漂移导致进/退赛判定偏差。
- 校准源：每轮 `fetchAllData` 已抓取的 `serverTime`（游戏 API 快照 `snapshot.serverTime` 优先，HTTP 直调路径取 `/api/biomes`/`/api/me` 兜底），**零新增请求**。
- 实现：新增 `updateClockDelta()` 在每次抓取时计算偏移 `clockDeltaMs = serverTime − 本地`；判定统一走 `serverNowMs()`（校准值 **5 分钟未刷新则自动回退纯本地时间**，防陈旧偏差）。`getActiveCompetitionTargets` 的 `now` 与 `_bjNowMin` 均已改用校准时间。
- 实测 fast：当时本地与服务器偏差约 −3.2 秒（毫秒级），校准主要应对长时间挂机时本地时钟漂移。
- **扩展弹窗展示**：Reelax 助手 popup「游戏状态」区块新增 **服务器时间 / 本地时间 / 时钟偏移** 三行（偏移量显示毫秒）。数据流：聚合.js `updateClockDelta` 每轮 `window.postMessage({__reelaxClock})` → injector.js 转发 `reelax-clock-status` → monitor.js 写 `m.clock` → popup.js `renderSync` 每 2s 刷新展示；均走既有消息通道，零新增请求。

### 新增：每 5 分钟巡检「当前地图公会增益」
- `monitor.js`：新增**每 5 分钟定时**（`chrome.alarms`，SW 休眠到点也能唤醒，`AUTO_BOOST_POLL_ALARM`）巡检**当前地图是否已开启公会经验增益**；若未开，则为当前地图按**当前天气剩余时长**折算份数补开（`handleAutoBoost` → 份数 `computeAutoBoostUnits(weatherEndsAt)`，只看剩余分钟、不看天气类型）。
- 完全复用现有 `handleAutoBoost` 的整套守卫：已有增益（`already-active`）、同一图 5 分钟冷却（`cooldown`）、献祭进度/距赛检查、份数折算与历史记录，因此不会重复购买已生效的增益。
- 巡检直接读 `refreshCurrentStatus` 每 30s 刷新的 `m.currentStatus`（当前图 `currentBiome` / 增益 `guildBoost` / 天气剩余 `weather.endsAt`），零新增状态接口。与既有「聚合选图通知驱动」开增益共存，互为兜底。

### 新增：弹窗「自动开增益」面板的公会增益监测
- `monitor.js`：每 5 分钟巡检**当前地图**是否已开启公会经验增益（`AUTO_BOOST_POLL_ALARM` + `pollCurrentMapAutoBoost`），未开则按当前天气剩余折算份数补开；完全复用 `handleAutoBoost` 的守卫（已有增益/冷却/献祭/距赛检查），不重复购买。每轮结果（含"已存在不购买"等）都 `recordAutoBoost` 写入历史并经 `__monitorStatus.autoBoost` 暴露。
- `popup.js` + `popup.html`：弹窗「监控 → 自动开增益」面板：
  - **「公会增益监测倒计时」**行（`#ab-poll-countdown`）显示距下次每 5 分钟巡检的剩余 `HH:MM:SS`（`fmtCountdown`，读 `m.autoBoostPollNextAt`）。
  - **「历史(最近10条)」**框输出每次监测结果（时间 + 动作 + 地图，含"已存在不购买"等），由 `refreshBoostResultUI()` 每 1 秒刷新（读 `m.autoBoostHistory`）。
  - 「公会增益」行保留秒级剩余倒计时（`🕒 剩 HH:MM:SS`）。

## [v1.5.1] - 2026-09-30

### Bug 修复
- `scripts/一键市场.js`：修复「按建议价一键重挂选中」按钮/可议价复选在列表重建后点击无效的问题。改为在常驻容器（`r1cm-log` / `rlb-list`）上**事件委托**捕获点击与变化，彻底规避 `el(btnId)` 取到旧节点、渲染后事件未绑定导致的按钮点不动。

## [v1.5.0] - 2026-09-30

### 新增：赛后加点退避重试
- `monitor.js`：公会赛 / 个人赛**赛后加点**由「单次执行失败即丢弃」改为**退避重试调度**（`runCompEndAttempt` / `fireCompEndRetry`）：
  - 最多尝试 **5 次**，间隔 30s → 1min → 2min → 4min（递增），执行期间被其它重置占用也按失败计后再退避重试。
  - 重试期间防重复：同一比赛 kind 已有进行中的重试任务则忽略；新比赛开始自动重置旧退避任务。
  - 连续失败 5 次后放弃，并通过 webhook 告警（含剩余未分配点数与末次失败原因）。
  - 成功或放弃后正确写入 `_compEndSig`，避免重复触发。

## [v1.4.1] - 2026-09-30

### 插件版本对齐
- `manifest.json` 版本从 `1.0.0` 对齐到 **`1.4.1`**：使 Chrome 扩展显示的版本号与发布 tag 保持一致。此前本地插件一直显示 1.0.0 是版本号未随历次发布同步导致。
- 约定：**每次发布 tag 时 `manifest.json` 的 `version` 与 tag 版本号同步递增**。

## [v1.4.0] - 2026-09-30

### 更新：一键市场（挂单/最低价侧）
- `scripts/一键市场.js`：
  - 新增**单鱼挂牌价下限门槛**（`minPrice`，与「不限制」开关联动，勾选不限制则输入框置灰视为 0）：挂单价低于门槛则跳过该鱼挂单，且**先算价、满足门槛才动旧单**，不再为跳过的鱼白白下架旧单。
  - 挂单流程重构：先拉盘口算出挂单价并核对门槛与活动挂单上限，再下架旧单 → 合并数量统一重挂；下架/挂单命中限流时**自动退避 5 秒重试一次**（新增 `isRateLimited` / `backoffIfRateLimited`）。
  - 「最低价检测 + 一键下架」改为**「最低价检测 + 勾选重挂」**：检测后列出非最低价挂单（默认全选，逐行复选框 + 忽略开关），勾选后点「勾选重挂（按设置挂单）」按设置价统一重挂，低于门槛自动跳过；失败/跳过/忽略的处理项保留显示并可继续处理，全部处理完才复位。
  - 落盘配置新增 `minPrice` / `minPriceLimit`，面板重开自动恢复；挂单区与捡漏区块分离（独立 `#r1cm-cheap-region`），不再清空状态日志。

## [v1.3.0] - 2026-09-30

### 更新：一键市场「专精鱼」筛选与下架/重挂可靠性
- `scripts/一键市场.js`：
  - 捡漏列表「仅拉取专精鱼」改为**视图层筛选**，勾选/取消无需重新扫描，直接在已拉取的单子中筛/放回专精鱼；空结果时给出明确提示。
  - 专精数据获取失败不再缓存空集合（避免持续 5 分钟把专精鱼误判为「无」，进而误报），失败时返回 `null` 并提示重试；有旧缓存则沿用。
  - 非最高价求购单的「下架 / 重挂」：**仅成功处理的条目才从待处理列表移除**；失败、忽略、未勾选的处理项保留显示并可继续逐条处理；全部处理完才切回「最高价检测」。
  - 下架失败自动取消勾选并保留显示，避免误重试。

### 数据（不再入库）
- `data/*.json`（`daily_raw.json`、`daily_report.json`）为运行期采集/生成的游戏数据，移出 git 版本控制并加入 `.gitignore`，不再进入发布 zip（避免随游戏运行而持续变动、也不带玩家昵称/公会等动态信息）。

## [v1.2.0] - 2026-09-30

### 新增：CI 自动打包发布
- 新增 GitHub Actions workflow（`.github/workflows/release.yml`）：push `v*` tag 时自动把源码打成 `reelax-script-dev-<tag>.zip` 并上传为 GitHub Release 资产，自动生成 release notes。
- zip 排除 `.git`、`__pycache__`、`login_credentials.js`（运行期敏感凭据）、临时/数据库文件。

### 说明
- 之前 v1.1.0 的源码 zip 由 GitHub 内建 tag 归档自动生成；自此版本起由 Actions 自定义打包发布，便于控制内容、排除敏感与临时文件。

## [v1.1.0] - 2026-09-30

### 更新
- **README 重写**：更新为 Chrome/Edge Manifest V3 版说明，替换原 Firefox 版文档。补充功能清单（自动切图+补满、自动出售、自动加点/加专精、保底监控、自动开公会增益、掉线/登录失效监控、一键市场含可议价重挂、日报采集、行情 SSE 采集）、Python 桥用法、文件结构、安装（`chrome://extensions` 加载已解压扩展）、配置说明与深入文档指引。

### 数据
- `data/daily_raw.json`：更新当日运行数据（`activeSec`、保底进度 `pity` 等）。

### 安全 / 隐私清理
- `devtools/test_admin_login.py`：将爆破测试中的**真实第三方账号**脱敏为占位符 `admin@REDACTED.example`，并标注禁止对他人账号执行。
- `docs/security-report.md`：将「已知管理员邮箱」真实邮箱打码为 `admin@REDACTED.example`（已脱敏）。
- `run.sh`：用法示例中的示例邮箱/密码改为通用占位 `you@example.com / yourpass`。

## [v1.0.0] - 2026-09-30

首次发布。将本地 Reelax 钓鱼游戏脚本开发技能（reelax-script-dev）完整上传至 GitHub，覆盖原占位初始提交。

### 新增
- 浏览器扩展主体：`manifest.json`、`background.js`、`injector.js`、`bridge.js`、`monitor.js`、`api.js`、`domclick.js`、`popup.html/js`、`options.html/js`、`chrome-polyfill.js`
- 注入脚本库（`scripts/`）：自动补满次数、自动加点、自动登录、自动出售库存、聚合、以物易物价格、日报采集、保底显示、装备初始价显示、装备属性占比、一键市场等
- Python API 封装（`api/`）：`fish_economy.py`、`gear_advisor.py`、`history_economy.py`、`parse_apis.py` 及接口文档
- DevTools 工具集（`devtools/`）：请求签名、探测脚本、脚本桥（`ws_bridge.py`）、行情大屏、爬取与提取工具、安全测试脚本
- 市场模块（`market/`）：情景扫描、挂单执行、价格与装备告警、以物易物扫描、量化交易框架文档
- 游戏自动化脚本（`gaming/`）：每日报告、开箱、装备/精通商店、状态检查及 PLAYBOOK
- 文档：`SKILL.md`、`README.md`、`CONTEXT.md`、`UpdateCheck.md`、安全报告（`docs/`）
- 资源配置：`.gitignore`（忽略 `__pycache__`、生成凭据、数据库等）、`run.sh`、`LICENSE`（MIT）