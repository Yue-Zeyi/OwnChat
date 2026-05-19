# OwnChat

<div align="center">
  <svg width="96" height="96" viewBox="0 0 64 64" role="img" aria-label="OwnChat" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="ownchat-bg" cx="30%" cy="24%" r="76%">
        <stop stop-color="#ffffff"/>
        <stop offset=".58" stop-color="#f6fbf7"/>
        <stop offset="1" stop-color="#dff0e5"/>
      </radialGradient>
      <linearGradient id="ownchat-face" x1="16" y1="18" x2="49" y2="51" gradientUnits="userSpaceOnUse">
        <stop stop-color="#18723b"/>
        <stop offset=".55" stop-color="#075125"/>
        <stop offset="1" stop-color="#022412"/>
      </linearGradient>
      <linearGradient id="ownchat-light" x1="22" y1="29" x2="42" y2="43" gradientUnits="userSpaceOnUse">
        <stop stop-color="#a8ffbd"/>
        <stop offset="1" stop-color="#55ef83"/>
      </linearGradient>
      <filter id="ownchat-shadow" x="-20%" y="-20%" width="140%" height="145%" color-interpolation-filters="sRGB">
        <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#052a15" flood-opacity=".22"/>
      </filter>
    </defs>
    <circle cx="32" cy="32" r="29" fill="#f8faf8"/>
    <circle cx="32" cy="32" r="26" fill="url(#ownchat-bg)" stroke="#e4ece7" stroke-width="1.2"/>
    <path d="M32 12v6" stroke="#0b5528" stroke-width="3" stroke-linecap="round"/>
    <circle cx="32" cy="10.5" r="3.4" fill="#0b5528"/>
    <circle cx="32" cy="10.5" r="1.35" fill="#8cffaa"/>
    <rect x="8.5" y="30" width="6" height="11" rx="3" fill="#0b5528"/>
    <rect x="49.5" y="30" width="6" height="11" rx="3" fill="#0b5528"/>
    <path d="M19.5 20h25C50.9 20 56 25.1 56 31.5v5C56 42.9 50.9 48 44.5 48H31.6l-9.5 7.1L23.7 48h-4.2C13.1 48 8 42.9 8 36.5v-5C8 25.1 13.1 20 19.5 20z" fill="url(#ownchat-face)" filter="url(#ownchat-shadow)"/>
    <path d="M16 29c2.1-2.6 5.3-3.9 9.4-3.9H39" fill="none" stroke="#2d9651" stroke-width="2.3" stroke-linecap="round" opacity=".55"/>
    <rect x="21" y="30" width="6.2" height="10.5" rx="3.1" fill="url(#ownchat-light)"/>
    <rect x="36.8" y="30" width="6.2" height="10.5" rx="3.1" fill="url(#ownchat-light)"/>
    <path d="M27.8 42.2c2.4 2.3 6 2.3 8.4 0" fill="none" stroke="#83f6a5" stroke-width="2.8" stroke-linecap="round"/>
    <path d="M48.5 16.5l1.7 3.6 3.6 1.7-3.6 1.7-1.7 3.6-1.7-3.6-3.6-1.7 3.6-1.7z" fill="#68f394"/>
  </svg>
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
boot.js
style.css
sw.js
ownchat.js
vendor.min.js
pdf.worker.min.js
```

可部署到：

- Nginx / Apache
- GitHub Pages
- Cloudflare Pages
- Vercel / Netlify 静态站点
- 任意本地静态服务器

Service Worker 需要 HTTPS 或 localhost。若 API 服务未开放 CORS，纯前端页面无法直接请求，需要服务端或网关支持 CORS。

页面内置了基础 CSP 和 `no-referrer` 元信息。若要禁止第三方站点嵌入页面，请在部署服务器上额外配置 `Content-Security-Policy: frame-ancestors 'none'` 或 `X-Frame-Options: DENY` 响应头；`frame-ancestors` 不能可靠地通过 HTML meta 生效。

## 文件说明

### 入口和样式

| 文件 | 说明 |
| --- | --- |
| `index.html` | 应用入口 HTML，包含基础 DOM、基础安全元信息和按顺序加载的脚本标签。 |
| `boot.js` | 首屏启动脚本，负责在 CSS 加载前恢复主题、模式和侧栏折叠状态，配合 CSP 避免内联脚本。 |
| `style.css` | 全局样式、响应式布局、聊天/绘画/设置弹窗/图片查看器/tooltip 和内联 SVG 头像样式。 |
| `README.md` | 项目说明文档。不是运行必需文件。 |

### 应用主逻辑

| 文件 | 说明 |
| --- | --- |
| `sw.js` | Service Worker，负责后台对话流请求、后台图片请求、停止请求、心跳和恢复 session 写入，并内置后台任务所需的协议工具。 |
| `ownchat.js` | 页面业务主包，包含协议工具、存储、Markdown、附件、数据库、API、设置导入、UI 工具、对话渲染、绘画渲染、侧栏、流式 UI、轮询和应用主控制器。 |

对话、绘画、侧栏等页面模块已合并进 `ownchat.js`，部署时不再需要保留拆分后的模块文件。

### 第三方库

| 文件 | 说明 |
| --- | --- |
| `vendor.min.js` | 第三方前端库集合，包含 Markdown 渲染、PDF.js 主库、Word 文档解析、表格解析和 ZIP 解析。 |
| `pdf.worker.min.js` | PDF.js worker 文件。 |

## 开发

没有构建步骤，修改后刷新浏览器即可。

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
