# OwnChat

OwnChat 是一个纯前端的自托管 AI 客户端，支持对话和绘画两种模式。项目只包含静态文件，不需要后端和构建步骤，部署到任意静态 Web 服务即可使用。

![OwnChat](icon.png)

## 功能

- 对话模式：支持 OpenAI-compatible `/chat/completions`
- 绘画模式：支持 `/images/generations`、`/images/edits`
- 支持流式输出、停止生成、重新生成
- 支持思考过程显示和折叠
- 支持文件附件、图片粘贴、Markdown 渲染、代码复制
- 支持多对话和绘画历史管理
- 支持绘画参考图、重绘、以图编辑、图片查看和下载
- 配置、会话、附件和图片历史保存在浏览器本地
- 支持深色 / 浅色主题和移动端布局

## 快速开始

直接用静态服务器打开项目目录：

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

首次使用时打开「设置」填写接口信息。

对话模式需要：

- Base URL，例如 `https://api.openai.com/v1`
- API Key
- 对话模型名

绘画模式需要：

- Image Base URL
- Image API Key
- 绘画模型名

如果对话接口和绘画接口相同，也可以填写相同的 Base URL 和 API Key。

## 使用说明

### 对话模式

- 输入消息后发送即可开始对话
- 可以上传图片、PDF、文本和代码文件
- 每个对话可以单独设置角色设定、Temperature、Top P、上下文上限
- 「携带上文」开关只影响当前对话
- 「思考过程」开关只影响当前对话
- 回复长度上限默认不传 `max_tokens`，只有手动填写时才会传给接口

### 绘画模式

- 输入提示词后点击生成
- 不点击「新绘画」时，后续生成会追加到当前绘画记录中
- 可以上传或粘贴参考图进行编辑
- 生成中的图片会显示耗时
- 图片可放大查看、复制、下载或作为参考图继续编辑

## 数据存储

OwnChat 的数据保存在当前浏览器本地：

- 配置和普通会话信息保存在 `localStorage`
- 附件、大图片和流式恢复数据保存在 `IndexedDB`

清理浏览器站点数据会删除这些内容。导出配置会包含 API Key，请不要分享给他人。

## 部署

部署时保留这些文件即可：

```text
index.html
app.js
style.css
sw.js
markdown-it.min.js
icon.png
```

建议使用 HTTPS 或本地 `http://127.0.0.1` 访问，这样 Service Worker 才能正常工作。

## 注意事项

- 本项目不会代理或隐藏 API Key，所有请求都从浏览器直接发出
- 不建议部署为公开多人服务，除非你自行处理鉴权、额度、合规和安全问题
- 不同 OpenAI-compatible 服务的参数限制不同，如遇到 400 报错，请检查模型名、参数和接口兼容性
- 绘画接口如果是长时间同步请求，Service Worker 会尽量保持后台请求，但浏览器不保证永久保活

## License

MIT
