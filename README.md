# OwnChat

<div align="center">
  <img src="icon.png" width="96" height="96" alt="OwnChat">
  <p><strong>纯前端、自托管、OpenAI-compatible 的对话和绘画客户端</strong></p>
  <p>
    <img alt="No build" src="https://img.shields.io/badge/build-none-10a37f">
    <img alt="Frontend only" src="https://img.shields.io/badge/frontend-only-10a37f">
    <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
  </p>
</div>

OwnChat 使用原生 HTML / CSS / JavaScript 实现，不需要后端服务和构建步骤。它支持对话模式和绘画模式，配置、会话、附件和绘画历史都保存在当前浏览器本地。

适合个人部署、自用模型网关、OpenAI-compatible 服务和多模型调试。

## 功能

- 纯前端运行，无框架、无构建步骤
- 支持 OpenAI-style Chat Completions、Images API、Responses API `image_generation`
- 支持对话流式输出、停止生成、重新生成和刷新恢复
- 支持 reasoning / thinking / `<think>` 思考过程展示
- 支持 Markdown、代码块、表格、任务列表和代码复制
- 支持图片、PDF、Office、文本、代码等附件
- 支持多会话管理、搜索、重命名、删除和批量删除
- 支持绘画历史、参考图编辑、以图编辑、重绘、图片查看、复制和下载
- 支持图片生成 token 用量记录和展示
- 支持提示词优化模型和 Responses API 映射生图
- 支持配置导入导出和 URL 参数导入
- 支持深色 / 浅色主题和移动端布局

## 快速开始

推荐用本地静态服务器打开：

```bash
php -S 127.0.0.1:8097
```

或：

```bash
python3 -m http.server 8097
```

然后访问：

```text
http://127.0.0.1:8097
```

也可以直接打开 `index.html`，但 `file://` 模式下 Service Worker 不可用，刷新恢复能力会受限。

## 配置

打开「设置」填写接口信息。

对话模式：

- Base URL，例如 `https://api.openai.com/v1`
- API Key
- 对话模型名

绘画模式：

- Image Base URL
- Image API Key
- 绘画模型名
- 可选：映射模型、提示词优化模型

对话和绘画配置互相隔离；如果使用同一个服务，可以填写相同的 Base URL 和 API Key。

## URL 快速导入

支持通过 URL 参数导入配置，适合从自己的配置页、脚本或书签首次打开时写入配置。

支持参数：

- `config`：URL 编码后的 JSON
- `config_b64`：base64url 编码后的 JSON
- `oc_config`：`config` 的别名
- `oc_config_b64`：`config_b64` 的别名

示例结构：

```json
{
  "mode": "chat",
  "chat": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "gpt-4o"
  },
  "image": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "gpt-image-2"
  }
}
```

应用识别到 URL 配置后会弹出确认预览，确认后才写入本地存储，并自动移除地址栏中的配置参数。URL 可能被浏览器历史、代理或服务器日志记录，不建议传递长期有效的 API Key。

## 对话模式

对话模式使用：

```text
POST /v1/chat/completions
GET  /v1/models
```

主要能力：

- 多轮对话和流式输出
- 每个对话独立角色设定
- 每个对话独立 Temperature、Top P、上下文上限
- 「携带上文」和「思考过程」开关只作用于当前对话
- 回复长度上限默认不传 `max_tokens`，只有手动填写时才发送
- 支持附件、图片粘贴、Markdown 渲染和代码复制
- 支持上文裁剪提示和 token 用量显示

## 绘画模式

绘画模式支持：

```text
POST /v1/images/generations
POST /v1/images/edits
POST /v1/responses + image_generation
```

主要能力：

- 文生图、参考图编辑、以图编辑
- 参考图最多 4 张；使用 Images edits 接口时按官方 `image` 多文件/数组方式提交
- 尺寸、质量、输出格式、背景参数
- 不点击「新绘画」时，后续生成会追加到当前绘画记录
- 生成中显示耗时和状态
- 图片查看器支持缩放、拖拽、切换、复制和下载
- 支持提示词优化模型
- 支持映射模式，通过 Responses API 调用 `image_generation` 工具
- 支持保存图片接口返回的 `usage`，meta 中紧凑显示 token 总量，悬停显示输入、输出和总计明细

## Service Worker

OwnChat 会注册 `sw.js`，用于长请求和刷新恢复：

- 对话流式回复恢复
- 图片生成结果恢复
- 切换会话时保持后台请求
- SW 不可用时自动回退到页面直接请求

注意：浏览器不保证 Service Worker 永久保活。长时间同步绘画请求可能受浏览器、移动端息屏、后台策略影响。如果需要生产级稳定任务，建议使用后端任务队列。

## 本地存储

OwnChat 不内置服务器，也不会主动上传配置和历史到除你配置的 API 服务之外的第三方。

| 存储位置 | 内容 |
| --- | --- |
| `localStorage` | 配置、对话文本、主题、当前模式 |
| `IndexedDB` | 附件、绘画历史、生成图片、临时流式会话 |

清理浏览器站点数据会删除配置、对话和图片历史。导出配置可能包含 API Key，请不要分享给他人。

## 部署

直接部署静态文件即可。需要保留这些文件：

```text
index.html
style.css
app.js
sw.js
icon.png
storage.js
markdown-renderer.js
attachments.js
chat-stream.js
token-utils.js
persistence-db.js
api-client.js
service-worker-client.js
config-import.js
ui-utils.js
icons.js
image-core.js
image-api-client.js
image-renderer.js
image-viewer.js
chat-renderer.js
sidebar-renderer.js
stream-ui.js
stream-session-poller.js
markdown-it.min.js
pdf.min.js
pdf.worker.min.js
mammoth.browser.min.js
xlsx.full.min.js
jszip.min.js
```

可部署到：

- Nginx / Apache
- GitHub Pages
- Cloudflare Pages
- Vercel / Netlify 静态站点
- 任意本地静态服务器

Service Worker 需要 HTTPS 或 localhost。若 API 服务未开放 CORS，纯前端页面无法直接请求，需要服务端或网关支持 CORS。

## 文件说明

### 入口和样式

| 文件 | 说明 |
| --- | --- |
| `index.html` | 应用入口 HTML，包含基础 DOM、首屏主题/模式防闪脚本和按顺序加载的脚本标签。 |
| `style.css` | 全局样式、响应式布局、聊天/绘画/设置弹窗/图片查看器/tooltip 等 UI 样式。 |
| `icon.png` | 应用图标，同时用于浏览器 favicon 和 AI 头像背景。 |
| `README.md` | 项目说明文档。不是运行必需文件。 |

### 应用主逻辑

| 文件 | 说明 |
| --- | --- |
| `app.js` | 应用主控制器，负责状态编排、事件绑定、模式切换、设置面板、聊天发送、绘画生成、恢复流程和各模块协作。 |
| `storage.js` | `localStorage` key 定义和通用保存/读取封装。 |
| `persistence-db.js` | IndexedDB 持久化层，负责附件、绘画历史、临时聊天流 session、临时图片 session。 |
| `api-client.js` | 通用 API 请求工具，负责 URL 规范化、fetch 包装和错误对象构建。 |
| `service-worker-client.js` | 页面侧 Service Worker 注册和可用性检测。 |
| `sw.js` | Service Worker，负责后台对话流请求、后台图片请求、停止请求、心跳和恢复 session 写入。 |
| `config-import.js` | URL/文件配置导入、base64url 解码、配置摘要和 API Key 遮罩。 |
| `ui-utils.js` | 通用 UI 小工具，例如复制菜单、文本复制、滚动和交互辅助。 |
| `icons.js` | 应用内使用的 SVG 图标集合。 |

### 对话模块

| 文件 | 说明 |
| --- | --- |
| `chat-stream.js` | Chat Completions SSE 解析、usage 规范化、流状态累积和流结束数据生成。 |
| `chat-renderer.js` | 对话消息 HTML 渲染，包含消息内容、meta、操作按钮、附件和 Markdown 输出。 |
| `stream-ui.js` | 流式回复 DOM 渲染层，负责 typing、stream message、思考过程展开/收起和内容增量渲染。 |
| `stream-session-poller.js` | 页面轮询 Service Worker 流式 session 时使用的进度状态、计时和终态判断工具。 |
| `markdown-renderer.js` | Markdown 渲染、安全转义、代码高亮、`<think>` 拆分和链接/图片清洗。 |
| `token-utils.js` | token 估算、上下文裁剪、数量格式化、`max_tokens` 显式参数处理。 |
| `attachments.js` | 附件读取、文件类型识别、附件消息构建、API 消息转换和附件校验。 |

### 绘画模块

| 文件 | 说明 |
| --- | --- |
| `image-core.js` | 绘画核心数据工具，负责图片输出解析、图片 usage 规范化、结果 meta、文件名、参考图、任务状态和 reply 数据结构。 |
| `image-api-client.js` | 图片 API 请求层，负责 Images generations、Images edits、Responses 映射生图和提示词优化请求。 |
| `image-renderer.js` | 绘画工作区 HTML 渲染，负责用户提示词、参考图、生成结果、图片 meta、token meta 和操作按钮。 |
| `image-viewer.js` | 图片查看器交互，负责打开、关闭、上一张/下一张、缩放、拖拽和平移。 |

### 侧栏模块

| 文件 | 说明 |
| --- | --- |
| `sidebar-renderer.js` | 侧栏渲染层，负责对话/绘画列表过滤、空状态、批量删除栏状态和侧栏 HTML。 |

### 开发检查

| 文件 | 说明 |
| --- | --- |
| `smoke.js` | 本地无依赖检查脚本，验证 `index.html` 脚本引用、部署清单和项目自有 JS 语法。不是运行必需文件。 |

### 第三方库

| 文件 | 说明 |
| --- | --- |
| `markdown-it.min.js` | Markdown 渲染库。 |
| `pdf.min.js` | PDF.js 主库，用于解析 PDF 附件。 |
| `pdf.worker.min.js` | PDF.js worker 文件。 |
| `mammoth.browser.min.js` | Word 文档解析库，用于读取 `.docx` 等附件文本。 |
| `xlsx.full.min.js` | 表格解析库，用于读取 `.xls`、`.xlsx`、`.csv`、`.tsv` 等附件。 |
| `jszip.min.js` | ZIP 解析库，供 Office 文档解析等场景使用。 |

## 开发

没有构建步骤，修改后刷新浏览器即可。

建议检查：

```bash
node smoke.js
```

`smoke.js` 会检查 `index.html` 引用脚本是否存在、部署清单是否包含页面脚本，并对项目自有 JS 执行语法检查。

修改 `sw.js` 后，如果浏览器仍使用旧版本，可以在 DevTools 的 Application / Service Workers 中手动更新，或清理站点数据后重新加载。

## 注意事项

- API Key 保存在当前浏览器本地，纯前端项目无法隐藏密钥
- 不建议直接公开部署给多人使用，除非你自行处理鉴权、限流、审计和合规
- 不同 OpenAI-compatible 服务的参数限制不同，遇到 400 报错请检查模型、参数和接口兼容性
- AI 输出可能不准确，请自行核实重要内容

## 合规提示

OwnChat 是静态前端客户端，不内置账号体系、实名能力、内容审核、日志审计、配额计费或上游授权管理。个人自用、内网调试和自有模型网关场景下，也应确认你的模型服务、数据处理方式和生成内容使用方式符合当地要求。

如果面向公众提供生成式 AI 服务，请自行处理备案、许可、内容安全、用户认证、日志留存、隐私政策、服务协议、税务和上游授权等合规事项。

## License

MIT
