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

## 特性

- 纯前端运行，无框架、无构建步骤
- 支持对话模式和绘画模式
- 兼容 OpenAI-style Chat Completions、Images API
- 支持流式输出、停止生成、重新生成
- 支持 reasoning / thinking / `<think>` 思考过程展示
- 支持 Markdown、代码块、表格、任务列表和代码复制
- 支持图片、PDF、文本、代码等附件
- 支持多会话管理、搜索、重命名、删除和批量删除
- 支持最多 4 张绘画参考图、重绘、以图编辑、图片查看、复制和下载
- 支持提示词优化模型和 Responses API 映射生图
- 支持配置导入导出和 URL 参数导入
- 支持 Service Worker 恢复流式回复和图片生成结果
- 支持深色 / 浅色主题和移动端布局

## 快速开始

直接部署静态文件即可。推荐用本地静态服务器打开：

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

### URL 快速导入

支持通过 GET 参数导入配置，适合从自己的配置页、脚本或书签首次打开时写入配置。

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

需要保留这些文件：

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
image-renderer.js
image-viewer.js
chat-renderer.js
stream-ui.js
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

## 开发

项目结构：

```text
.
├── index.html
├── style.css
├── app.js
├── sw.js
├── icon.png
├── storage.js
├── markdown-renderer.js
├── attachments.js
├── chat-stream.js
├── token-utils.js
├── persistence-db.js
├── api-client.js
├── service-worker-client.js
├── config-import.js
├── ui-utils.js
├── icons.js
├── image-core.js
├── image-renderer.js
├── image-viewer.js
├── chat-renderer.js
├── stream-ui.js
├── markdown-it.min.js
├── pdf.min.js
├── pdf.worker.min.js
├── mammoth.browser.min.js
├── xlsx.full.min.js
├── jszip.min.js
└── README.md
```

没有构建步骤，修改后刷新浏览器即可。

建议检查：

```bash
node --check app.js
node --check sw.js
node --check chat-stream.js
node --check attachments.js
```

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
