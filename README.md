# Reelax 助手（Firefox 扩展）

浏览器启动时自动打开 [reelax.cn](https://reelax.cn/)，并向该站点注入可配置的 JS 脚本（默认已包含「自动补满次数」油猴脚本，每 10 秒检查自动钓鱼剩余次数、不足时自动点击补满）。

## 功能

- **开机自动打开**：浏览器启动时自动打开目标网站（可在设置中关闭）。
- **脚本注入**：把 `scripts/` 文件夹里的 JS 文件（或自定义代码）注入到目标网站的主世界，等效于油猴脚本（`@grant none`）。
- **可配置**：通过扩展设置页配置目标 URL、要注入的脚本、自定义代码、自动刷新间隔。
- **工具栏弹窗**：一键打开目标网站 / 打开设置。

## 文件结构

```
firefox-extension/
├── manifest.json        # 扩展清单（Manifest V2）
├── background.js         # 后台：自动打开 + 脚本注入 + 自动刷新
├── options.html/js       # 设置页
├── popup.html/js         # 工具栏弹窗
└── scripts/
    └── 自动补满次数.js    # 默认注入的油猴脚本
```

## 安装（临时加载，无需签名）

1. 打开 Firefox，地址栏输入 `about:debugging` 并回车。
2. 左侧点击 **此 Firefox**（This Firefox）。
3. 点击 **临时载入附加组件**（Load Temporary Add-on）。
4. 选择本目录下的 `manifest.json`。
5. 扩展即生效：重启浏览器会看到自动打开目标站；打开站点后脚本自动注入。

> 临时加载的扩展在浏览器完全关闭后会失效，需重新载入。若要长期固定使用，需自行签名发布或用开发者版本 Firefox 的 `extensions/` 目录放置。

## 如何新增要注入的 JS

1. 把你的 `.js` 文件放到 `scripts/` 文件夹。
2. 打开扩展设置页（`about:addons` → Reelax 助手 → 选项，或点工具栏弹窗的「扩展设置」）。
3. 若是自带脚本，勾选它；若是新文件，在「额外脚本文件名」里每行填一个文件名。
4. 保存。下次目标网站加载即生效。

也可以在「自定义代码」框里直接粘贴 JS，无需建文件。

## 说明与限制

- **关于「JS 文件夹」**：浏览器安全策略不允许扩展在运行时读取磁盘上任意路径（如 `workspace/firefox`）的文件。因此脚本需随扩展一起打包在 `scripts/` 文件夹内，再用设置页选择注入。这是对「设置 JS 文件夹」这一需求的标准可行实现。
- 注入时机为页面 `document_idle`（加载完成后），与油猴 `run-at: document-idle` 一致。
- 脚本运行在页面主世界（main world），可直接访问页面 DOM 与全局变量，与油猴 `@grant none` 行为一致。
- 默认仅对 `reelax.cn` 注入。若要支持其它站点，需修改 `manifest.json` 的 `permissions` 与 `background.js` 的匹配逻辑。

## 可选「自动刷新」

设置页的「自动刷新间隔」可让已打开的目标标签页每隔 N 分钟自动刷新（用于保活会话）。设为 0 即关闭。

## 自动登录凭据（FISH_EMAIL / FISH_PASSWD）

`run.sh` 会把登录凭据交给 `scripts/自动登录.js`。脚本**不硬编码任何账号密码**，只从运行期注入的凭据读取：

1. `run.sh --login <邮箱> <密码>`（参数优先）
2. 环境变量 `FISH_EMAIL` / `FISH_PASSWD`

未配置凭据时，`自动登录.js` 不执行自动登录。

用法：

```bash
# 用参数指定
./run.sh --login 12212@qq.com 12345

# 或用环境变量（自动登录.js 优先读取）
FISH_EMAIL=12212@qq.com FISH_PASSWD=12345 ./run.sh
```

实现方式：`run.sh` 依据上述来源生成 `scripts/login_credentials.js`（设置 `window.__REELAX_LOGIN__`），扩展的 `injector.js` 会先于 `自动登录.js` 把它注入页面主世界。该文件为运行期生成，已被 `.gitignore` 忽略、不纳入版本库；未设置凭据时自动删除，`自动登录.js` 不执行自动登录。
