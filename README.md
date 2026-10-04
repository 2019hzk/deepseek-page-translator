# DeepSeek 整页翻译

一个 Chrome 浏览器插件（Manifest V3），调用 [DeepSeek 官方 API](https://platform.deepseek.com/) 把整个网页翻译成你需要的语言。纯原生 JavaScript 编写，无需构建，下载即可加载使用。

## 功能特性

- **整页翻译**：一键翻译当前网页，再次点击可在原文与译文之间切换。
- **快捷键**：`Alt+A` 直接翻译当前页面 / 切换原文与译文。
- **按需翻译，节省费用**：只翻译视口附近的内容，滚动到哪里翻译到哪里，长页面不会一次性消耗大量 Token。
- **批量请求与去重**：多段文本合并成一次请求，页面内重复文本只翻译一次，并带有页面级缓存。
- **动态内容支持**：自动翻译页面后续加载的内容（无限滚动、单页应用等）。
- **智能跳过**：代码块、输入框、纯数字，以及已经是目标语言（中文）的段落不会发送给 API。
- **容错处理**：模型返回段数不一致时自动拆分重试；遇到限流或服务繁忙自动退避重试；API Key 无效、余额不足时停止翻译并提示原因。
- **不破坏页面**：只替换文本内容，保留原页面的链接、样式和交互；进度浮窗使用 Shadow DOM，不受页面样式影响。
- **多语言**：支持翻译为简体中文、繁體中文、English、日本語、한국어、Français、Deutsch、Español、Русский。

## 安装

1. 克隆或下载本仓库：

   ```bash
   git clone https://github.com/<你的用户名>/deepseek-page-translator.git
   ```

2. 打开 Chrome，访问 `chrome://extensions`。
3. 打开右上角的 **开发者模式**。
4. 点击 **加载已解压的扩展程序**，选择本项目文件夹。

> 同样适用于 Edge 等基于 Chromium 的浏览器（Edge 中访问 `edge://extensions`）。

## 配置

1. 在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建 API Key。
2. 右键浏览器工具栏中的插件图标，选择 **选项**，打开设置页。
3. 填写以下内容后点击 **保存并测试连接**：

| 设置项 | 说明 | 默认值 |
| --- | --- | --- |
| DeepSeek API Key | 你的 API Key，形如 `sk-...` | 无 |
| 模型 | 使用的模型名称 | `deepseek-chat` |
| 默认目标语言 | 翻译成的语言 | 简体中文 |

> 推荐使用 `deepseek-chat`：速度快、成本低。`deepseek-reasoner` 会先输出推理过程，用于翻译会明显变慢且更贵。

## 使用

- 点击工具栏中的插件图标，然后点击 **翻译当前页面**；或者直接按 `Alt+A`。
- 翻译进度显示在页面右下角的浮窗中，可在浮窗里切换 **显示原文 / 显示译文**。
- 在弹窗中切换目标语言后，刷新页面再重新翻译即可生效。
- 快捷键可在 `chrome://extensions/shortcuts` 中修改。

## 项目结构

```text
deepseek-page-translator/
├── manifest.json   # 插件配置（Manifest V3）
├── background.js   # Service Worker：调用 DeepSeek API、重试与错误处理、快捷键
├── content.js      # 注入网页：收集文本、批量翻译、替换译文、原文切换、进度浮窗
├── settings.js     # 默认设置与支持的目标语言
├── popup.html/css/js     # 工具栏弹窗
└── options.html/css/js   # 设置页
```

## 工作原理

1. 点击翻译后，插件通过 `chrome.scripting` 把 `content.js` 注入当前页面。
2. `content.js` 遍历页面中的文本节点，用 `IntersectionObserver` 只把进入视口附近的文本加入队列。
3. 队列中的文本去重后按批次（每批最多 40 段 / 2500 字符，最多 3 个并发）发送给 `background.js`。
4. `background.js` 以 JSON 模式调用 DeepSeek `chat/completions` 接口，要求模型按原顺序返回等长的译文数组；数量不一致时把批次一分为二重试。
5. 译文写回对应的文本节点，并保留原文，以便随时切换。
6. `MutationObserver` 监听页面变化，新增内容会自动进入翻译流程。

## 隐私与权限

- **API Key 只保存在本机**（`chrome.storage.local`），不会随 Chrome 账号同步，也不会发送到 DeepSeek 以外的任何服务器。
- 网页文本只会发送到 `https://api.deepseek.com`，用于翻译。
- 插件申请的权限：

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 仅在你点击插件或按快捷键时访问当前标签页 |
| `scripting` | 向当前页面注入翻译脚本 |
| `storage` | 保存 API Key 和设置 |
| `https://api.deepseek.com/*` | 调用 DeepSeek API |

插件不会在你未操作时自动读取或修改任何网页。

## 已知限制

- 翻译以文本节点为单位。像 `Read the <a>docs</a> now` 这种被链接、加粗等标签切开的句子，会被拆成几段分别翻译，个别译文语序可能不够自然。
- 不翻译 iframe 内的内容和 Shadow DOM 内的内容。
- 浏览器内置页面（`chrome://`）和 Chrome 应用商店页面无法注入脚本，因此不能翻译。
- 目标语言为中文时，以汉字为主的段落会被视为已翻译而跳过，因此不会做简繁互转。

## 常见问题

**提示"API Key 无效"**：检查设置页中的 Key 是否完整，是否已在 DeepSeek 平台被删除。

**提示"账户余额不足"**：前往 [DeepSeek 开放平台](https://platform.deepseek.com/) 充值。

**提示"请求过于频繁"**：插件会自动重试；如果持续出现，请稍后再试。

**修改代码后不生效**：在 `chrome://extensions` 中点击插件卡片上的刷新按钮，然后刷新要翻译的网页。
