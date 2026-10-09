# 更新记录

本项目变更记录。每次 Release 会同步写到此文件并打 git tag。

> 版本递增规则：破坏性修改 → MAJOR+1（高位清零）；向下兼容新功能 → MINOR+1；向下兼容 Bug 修复 → PATCH+1；升高位后低位清零。

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