# DOM 通用点击参考（/__domclick）🖱️

> 把扩展的「DOM 兜底点击」扩展成**通用点击器**：想点页面里任意元素就能点。
> 走本地桥（WS 127.0.0.1:55004）下发，扩展后台注入到游戏页面主世界执行，无需改扩展代码。

## 背景

- `domclick.js` 原本只在 `api.js` 写操作返回 `INTERNAL_ERROR` 时，按 `RULES` 映射表点**固定的按钮**兜底。
- 现在扩展为通用能力：公开 `DomFallback.click(opts)`，并通过桥暴露虚拟路径 `/__domclick`，让外部（Python/脚本）可以按 **selector / 文本 / 选项** 点页面上任意元素。
- 典型用途：页面有引导按钮（如「前往围猎」）想点掉、某操作前端点击才有效、排查页面元素交互等。

## 调用方式（推荐：通过桥）

扩展后台 `bridge.js` 处理 `path === '/__domclick'`，把 `body` 原样交给 `DomFallback.click(body)` 执行，并把结果回传。

### Python（devtools/api.py）

```python
from devtools import api
c = api.ReelaxApi()

# 1) 按 selector 点第一个匹配元素
c._post('/__domclick', body={'selector': 'button.topbar-fishing-status'})

# 2) 按文本筛选 + 点全部（如所有「前往围猎」导航按钮）
c._post('/__domclick', body={
    'selector': 'a[href="/events?event=world-boss"]',
    'text': '前往围猎',
    'all': True,
})

# 3) 点弹窗里的「确认」按钮并自动确认二次弹窗
c._post('/__domclick', body={
    'selector': 'dialog button.primary-button',
    'text': '确认',
    'extraConfirm': True,
})
```

> `_post(path, body=body)` 会带幂等键，但对虚拟路径 `/__domclick` 无副作用；也可直接 `api.Bridge().submit('/__domclick', method='POST', body=body)`。

### 原始桥消息

```json
{
  "method": "POST",
  "path": "/__domclick",
  "body": { "selector": "...", "text": "...", "all": true }
}
```

## 参数（body）

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `selector` | ✅ | string | CSS 选择器，传给 `document.querySelector(All)` |
| `text` | 否 | string | 子串，仅匹配**可见文本包含**该子串的元素（不区分大小写） |
| `all` | 否 | boolean | `true` 用 `querySelectorAll` 点**所有**匹配项；`false`(默认) 只点第一个 |
| `match` | 否 | string | 额外校验函数体（字符串，注入页面后 eval），入参 `el`，返回 true 才点 |
| `beforeClick` | 否 | string | 点击前在页面执行的 JS 片段（如滚动、开弹窗） |
| `extraConfirm` | 否 | boolean | 点击后等 300ms 尝试点「确认」类按钮（`button.primary-button` / `button[class*=confirm]`） |
| `maxClicks` | 否 | number | 每个元素最多点击次数（默认 1） |

> `selector` 也可直接传字符串（等价于只给 selector）。

## 返回值

`bridge.js` 回传 `{ status, ok, data }`，其中 `data` 是 `DomFallback.click()` 的结果：

```json
{
  "ok": true,
  "reason": "clicked",
  "out": {
    "found": true,      // 是否找到元素
    "matched": true,    // 是否通过 text / match 筛选
    "clicked": true,    // 是否至少点中一个
    "total": 1,         // all 模式匹配到的元素总数
    "clicks": 1,        // 实际点击次数
    "reason": ""        // 失败原因（no-element / not-match / disabled 等）
  }
}
```

失败时 `reason` 常见取值：`no-element`、`not-match`、`disabled`、`no-tab`（没有 reelax 标签页）、`bad-arg`、`no-selector`。

## 扩展内部调用（不经过桥）

扩展后台脚本（monitor.js 等）可直接用：

```js
await DomFallback.click('button.topbar-fishing-status');
await DomFallback.click({ selector: 'a[href="/events?event=world-boss"]', text: '前往围猎', all: true });
await DomFallback.click({ selector: '.foo button', all: true, extraConfirm: true });
```

## 实测样例

```
POST /__domclick  body: { selector: 'a[href="/events?event=world-boss"]', text: '前往围猎', all: true }
→ status: 200  ok: true
→ data: { "ok": true, "reason": "clicked",
          "out": { "found": true, "clicked": true, "matched": true, "total": 1, "clicks": 1 } }
```

## 注意事项

- `/__domclick` 是**扩展本地虚拟路径**，不会向 reelax 服务端发请求，**不签名、不计入 taskCount**。
- 它只对**已打开的 reelax 标签页**生效（`browser.tabs.query({url:'*://reelax.cn/*'})`，取第一个）。
- 点击只是「触发页面元素」，**不等于**后端状态一定改变——是否生效取决于该元素/按钮对应的页面逻辑。
- 若改动了 `domclick.js` / `bridge.js`，需扩展重载后才生效（web-ext 通常自动重载；必要时重启 run.sh）。
