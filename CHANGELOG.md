# 更新记录

本项目变更记录。每次 Release 会同步写到此文件并打 git tag。

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