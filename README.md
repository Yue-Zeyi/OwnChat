# OwnChat

<div align="center">
  <img src="icon.png" width="96" height="96" alt="OwnChat">
</div>

OwnChat 是一款纯前端的自用 AI 客户端，支持对话和绘画两种模式。项目不依赖后端服务，配置、会话和绘画历史都保存在当前浏览器本地。

## 特性

- **纯前端运行**：原生 HTML / CSS / JavaScript 实现，无框架、无构建步骤。
- **Service Worker 代理**：SW 作为唯一 API 代理，页面刷新不中断流式回复和图片生成。
- **对话模式**：兼容 OpenAI Chat Completions 格式，支持角色设定、流式输出、reasoning 展示、多会话管理和基于 `markdown-it` 的 Markdown 渲染。
- **绘画模式**：兼容 OpenAI Images API，支持文生图、参考图编辑、提示词优化、生成历史、大图查看、复制和下载。
- **映射模式**：绘画可选映射模型，通过 Responses API 强制调用 `image_generation` 工具生成图片。
- **配置隔离**：对话和绘画使用独立的 Base URL、API Key、模型列表和当前模型，互不污染。
- **稍后配置**：未配置时也可以浏览和切换模式；只有发送消息或生成图片时才会提示配置。
- **配置备份**：支持导出脱敏配置、含密钥完整配置，以及从 JSON 文件恢复配置。
- **搜索和诊断**：支持侧栏搜索对话/绘画历史，网络错误会给出可复制的诊断信息。
- **模型管理**：支持从 `/models` 刷新模型，也支持手动填写未出现在列表中的模型。
- **本地存储**：对话文本保存在 `localStorage`，文件附件和绘画历史保存在 IndexedDB。
- **文件上传**：对话支持图片和常见文本文件；绘画支持上传一张参考图进行编辑。
- **上下文裁剪**：每对话可配置上下文 Token 上限（默认 128K），超出时自动裁剪旧消息，设为 0 则不裁剪。
- **Token 统计**：累计记录输入/输出 token 消耗，并在每条消息上显示首 token 延迟和思考耗时。
- **代码高亮**：内置多语言语法高亮，支持注释、字符串、关键字、数字和函数名着色。
- **多主题和移动端**：支持深色/浅色主题和移动端响应式布局。

## 快速开始

直接打开 `index.html` 即可使用，也可以用任意静态服务器部署整个目录。

首次打开即可进入主界面。你可以稍后配置 API；未配置时，点击发送或生成会弹出对应配置窗口。

对话配置：

1. 填写对话 **Base URL**，例如 `https://api.openai.com/v1`。
2. 填写对话 **API Key**。
3. 刷新或手动填写对话模型。
4. 保存后即可对话。

如果要使用绘画模式，进入「设置 → 绘画」单独配置：

1. 填写 **Image Base URL**。
2. 填写 **Image API Key**。
3. 选择或手动填写绘画模型，默认推荐 `gpt-image-2`。
4. 如需映射模式，可选择或手动填写映射模型；留空表示关闭映射。
5. 如需使用提示词优化，可选择或手动填写提示词优化模型；它只用于优化提示词，不影响实际生图模型。

### 快速导入配置

可以通过 GET 参数快速写入本地配置，适合从自己的配置页、脚本或书签链接一键打开 OwnChat。

支持四种参数：

- `config`：URL 编码后的 JSON 字符串
- `config_b64`：base64url 编码后的 JSON 字符串，适合更长配置
- `oc_config`：`config` 的别名
- `oc_config_b64`：`config_b64` 的别名

示例 JSON：

```json
{
  "mode": "chat",
  "chat": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "gpt-4o",
    "models": ["gpt-4o", "gpt-4o-mini"]
  },
  "image": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "gpt-image-2",
    "mapModel": "",
    "promptModel": "gpt-4o-mini",
    "models": ["gpt-image-2", "gpt-4o-mini"],
    "defaults": {
      "size": "1024x1024",
      "quality": "auto",
      "outputFormat": "png",
      "background": "auto"
    }
  }
}
```

导入时支持多种字段名格式（`baseUrl`、`base_url`、`apiKey`、`api_key`、`imageBaseUrl`、`image_base_url` 等均可识别）。

URL 形式：

```text
index.html?config=%7B%22chat%22%3A%7B%22baseUrl%22%3A%22https%3A%2F%2Fapi.openai.com%2Fv1%22%2C%22apiKey%22%3A%22sk-...%22%2C%22model%22%3A%22gpt-4o%22%7D%7D
```

识别到 URL 配置后，OwnChat 会先弹出确认预览，并对 API Key 做脱敏显示。确认导入后才会写入浏览器本地存储，并自动从地址栏移除配置参数。

注意：GET URL 可能被浏览器历史、代理或服务器访问日志记录，不建议在公共环境传递长期有效的 API Key。更安全的方式是在「设置 → 对话」里使用「导入配置」从本地 JSON 文件恢复。

### 配置备份和恢复

「设置 → 对话」提供三个配置工具：

- **导出配置**：导出不包含 API Key 的配置，适合备份和分享。
- **含密钥导出**：导出包含 API Key 的完整配置，适合私人设备迁移。
- **导入配置**：从 JSON 文件读取配置，导入前会显示确认预览。

## Service Worker 代理

OwnChat 使用 Service Worker (`sw.js`) 作为唯一 API 代理，页面本身不做直接 `fetch` 请求。所有对话流式请求和图片生成请求都通过 `postMessage` 发送给 SW，由 SW 执行实际的 API 调用，结果写入 IndexedDB，页面通过定时读取 IndexedDB 获取数据。

这个架构带来了几个关键能力：

- **刷新不中断回复**：页面刷新时 SW 继续运行，流式回复不会中断。重新加载后自动恢复已有内容并继续接收。
- **刷新不中断生图**：图片生成同样由 SW 代理，刷新后可恢复生成结果或继续等待。
- **切换对话不中断生成**：切换到其他对话时，原对话的流式回复在 SW 中继续。切换回来时自动恢复 UI 显示。
- **仅一次 API 调用**：SW 作为唯一代理，不会出现页面和 SW 重复请求导致双倍 token 消耗。

如果浏览器不支持 Service Worker 或 SW 未注册，会自动回退到页面直接 `fetch` 模式，仍可正常使用，但失去上述恢复能力。回退模式下每 2 秒将部分内容写入 `localStorage` 用于崩溃恢复。

### 流式回复恢复流程

```text
发送消息 → SW 发起 /chat/completions → SW 每隔 300ms 写入 IndexedDB
页面每 100ms 读取 IndexedDB → 更新 DOM（requestAnimationFrame 节流）
```

页面刷新时的恢复：

```text
页面加载 → 检查 IndexedDB 会话 → 状态为 complete：直接插入完整回复
                                    → 状态为 streaming：启动恢复轮询，实时显示
                                    → 状态为 stopped/error：显示中断标记
                                    → 超过 60s 无更新：标记为中断
```

### 图片生成恢复流程

图片生成同样通过 SW 代理，支持三种请求类型：

- **generations**：`/v1/images/generations` 文生图
- **responses**：`/v1/responses` 映射模式
- **edit**：`/v1/images/edits` 参考图编辑（SW 从序列化参数重建 FormData）

刷新后的恢复逻辑与对话类似，超时阈值为 10 分钟。

### 对话切换时的流式处理

切换对话时：

```text
pauseActivePolls() → 仅清除 UI 轮询定时器，SW 继续生成
切换到新对话 → resumeStreamPollIfNeeded() 检查新对话是否有流式占位符
  → 有且 SW 会话匹配：恢复 UI 轮询
  → 有但 SW 会话已完成：直接结束消息
  → 有但 SW 会话不匹配：标记为已停止
  → 无占位符：正常显示对话
```

在旧对话流式进行中发送新消息时，会先中止旧对话的流并标记为"已停止生成"，再开始新请求。

## 对话模式

对话模式支持：

- 新建、切换、重命名、删除会话
- 搜索对话标题、角色设定和消息内容
- 每个对话独立角色设定，会作为 `system` 消息发送
- 流式回复，刷新或切换对话不中断生成
- reasoning / thinking 内容折叠展示（支持 API `reasoning_content` 字段和 `<think>` 标签）
- 基于本地 `markdown-it` 的 Markdown 渲染，支持加粗、列表、表格、代码块、任务列表、图片链接等常见语法
- 代码语法高亮和复制按钮由应用内置实现；`markdown-it` 加载失败时会回退到内置简化渲染器
- 上下文自动裁剪（每个对话可配置上限，默认 128K；超出时从前面裁剪，保留 system 消息和最后一轮对话；设为 0 则不裁剪）
- 上传图片、PDF、文本、代码等文件作为上下文（base64 存储在 IndexedDB，不占 localStorage）
- 每个会话独立设置 Temperature、Top P、Max Tokens、上下文上限
- Token 统计：累计输入/输出 token，每条消息显示首 token 延迟
- URL 安全过滤：仅允许 `http`、`https`、`mailto`、`tel` 和 `data:image` 协议
- 未配置时点击发送会打开对话设置；设置窗口可以关闭，不会阻塞使用界面

对话模式使用接口：

```text
POST /v1/chat/completions
GET  /v1/models
```

## 绘画模式

绘画模式支持三条路径：

- **文生图**：没有参考图时，调用 `/v1/images/generations`
- **参考图编辑**：上传参考图或从历史图片点击「以图编辑」时，调用 `/v1/images/edits`
- **映射生图/编辑**：配置映射模型后，会调用 `/v1/responses`，并要求模型调用 `image_generation` 工具；如有参考图，会把参考图作为 image input 一起发送

绘画模式支持：

- 独立绘画模型配置
- 尺寸、质量、格式、背景参数，默认尺寸为 `auto`
- 调用 AI 优化绘画提示词
- 生成中等待状态、预计耗时提示，以及完成后的实际耗时
- 历史记录
- 统计浏览器存储占用、保留最近 20 条、清空绘画历史
- 图片点击放大查看
- 图片结果显示实际尺寸、格式和文件大小
- 复制图片或图片链接
- 下载图片
- 从生成结果继续「以图编辑」
- 可选映射模型，可随时关闭并切回原 Images API
- 刷新不中断生成（SW 代理模式下可恢复完整结果）
- 未配置时点击生成/编辑会打开绘画设置；设置窗口可以关闭，不会阻塞切换模式

目前绘画模式一次只生成一张图片。

### 提示词优化

绘画输入框左侧的闪光按钮用于优化当前提示词。该功能使用「设置 → 绘画」里的提示词优化模型，请选择一个支持 `/v1/chat/completions` 的对话模型。

提示词优化和实际生图是隔离的：

- 优化请求使用绘画 **Base URL** 和绘画 **API Key**。
- 优化模型只负责改写提示词，不参与生成图片。
- 绘画模型仍负责 Images API 生图；映射模型仍只负责 Responses API + `image_generation` 生图。
- 留空提示词优化模型时，点击优化按钮会打开绘画设置，不会自动使用对话配置。

### 映射模式说明

映射模式适合让一个通用模型通过工具来生成图片。启用后，OwnChat 会把绘画请求发送到 `/v1/responses`，并要求映射模型调用 `image_generation` 工具。

请求逻辑：

```text
用户提示词 / 参考图
  → 映射模型
  → tool_choice: required
  → image_generation 工具
  → 返回图片
```

注意：

- 映射模型不是直接生图，真正生成图片的是 `image_generation` 工具。
- 有参考图时，参考图会作为 `input_image` 一起发送给 Responses API。
- 如果关闭映射模型，会自动回到原来的 Images API 流程。
- 不是所有 OpenAI-compatible 服务都支持 Responses API 或 `image_generation` 工具。

## 存储说明

OwnChat 不会主动把配置和历史发送给除你配置的 API 服务之外的第三方。

本地存储分布：

- **localStorage**：对话配置、对话文本、绘画配置、主题、当前模式、Token 统计等轻量数据
- **IndexedDB (`ownchat_stream_db`)**：SW 流式会话和图片生成会话的临时数据（完成后自动清理）
- **IndexedDB (`ownchat_image_db`)**：绘画历史图片数据和对话文件附件（base64）

数据隔离策略：

- 对话消息中的文件附件（base64 图片等）在持久化前自动提取到 IndexedDB，加载时再注入回去，避免 localStorage 空间不足。
- 绘画历史图片直接存储在 IndexedDB 的 `jobs` 和 `files` store 中。
- SW 流式会话数据存储在 IndexedDB 的 `sessions` store 中，作为临时缓冲，回复完成后自动清理。

浏览器存储空间有限。绘画图片体积较大，如果历史保存失败，当前页面仍可查看刚生成的图片，但刷新后可能不会保留。

## OpenAI-Compatible 服务注意事项

不同 OpenAI-compatible 服务对 Images API 参数支持不完全一致。OwnChat 做了基础兼容：

- 如果绘画接口不支持 `quality`、`output_format`、`background`，会自动用更小的参数集重试一次。
- 如果映射模式下服务不支持 `tool_choice: "required"`，会尝试使用 `{ type: "image_generation" }` 形式重试。
- 如果服务返回图片 URL 而不是 base64，复制操作会复制图片链接；下载可能会由浏览器打开新链接。
- `/models` 不一定能区分对话模型和绘画模型，因此对话和绘画都支持手动填写模型名。
- 请求失败时，错误信息会尽量包含请求地址、页面地址、HTTP 状态和排查建议，便于复制诊断。
- 上下文超出对话配置的上限（默认 128K）时自动裁剪前面消息，始终保留 system 消息和最后一轮对话。设为 0 则不裁剪。

## 部署

这是静态项目，部署时需要提供以下文件：

```text
index.html   # 页面结构
style.css    # 样式和响应式布局
app.js       # 应用逻辑、API 请求、本地存储
sw.js        # Service Worker，唯一 API 代理
icon.png     # 品牌 Logo、对话头像和 favicon
vendor/      # 前端第三方依赖，目前包含 markdown-it
```

可以直接放到任意静态托管服务、Nginx、Apache、GitHub Pages 或本地静态服务器中。

注意：Service Worker 要求页面通过 HTTPS 或 `localhost` 访问才能注册。如果在非 HTTPS 环境部署，SW 无法注册，应用会自动回退到页面直接请求模式。

## 开发

项目结构：

```text
.
├── index.html   # 页面结构
├── style.css    # 样式和响应式布局
├── app.js       # 应用逻辑、API 请求、本地存储
├── sw.js        # Service Worker，唯一 API 代理
├── icon.png     # 品牌 Logo、对话头像和 favicon
├── vendor/
│   └── markdown-it.min.js
└── README.md    # 项目说明
```

本项目没有构建步骤。修改文件后刷新浏览器即可。修改 `sw.js` 后需要关闭所有标签页再重新打开，或者在 DevTools → Application → Service Workers 中手动更新。

`vendor/markdown-it.min.js` 是浏览器端 Markdown 解析器的本地构建文件，用于避免运行时依赖 CDN。升级时替换该文件，并确认 `index.html` 的加载路径不变。

如果需要本地服务，可以在项目目录运行任意静态服务器，例如：

```bash
php -S 127.0.0.1:8097
# 或
python3 -m http.server 8097
```

## 安全提示

- API Key 仅保存在浏览器本地，但本地浏览器环境并不等同于密钥保险箱。
- 不建议在公共或不可信设备上保存长期有效的 API Key。
- AI 输出可能不准确，请核实重要信息。
- 绘画和对话请求会发送到你配置的 Base URL，请确认服务提供方可信。
- URL 中的链接和图片经过安全过滤，仅允许 `http`、`https`、`mailto`、`tel` 和 `data:image` 协议。

## License

MIT
