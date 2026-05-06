# OwnChat

OwnChat 是一款纯前端的自用 AI 客户端，支持聊天和绘画两种模式。项目不依赖后端服务，配置、会话和绘画历史都保存在当前浏览器本地。

## 特性

- **纯前端运行**：原生 HTML / CSS / JavaScript 实现，无框架、无构建步骤。
- **聊天模式**：兼容 OpenAI Chat Completions 格式，支持流式输出、reasoning 展示、多会话管理和 Markdown 渲染。
- **绘画模式**：兼容 OpenAI Images API，支持文生图、参考图编辑、生成历史、大图查看、复制和下载。
- **映射模式**：绘画可选映射模型，通过 Responses API 强制调用 `image_generation` 工具生成图片。
- **配置隔离**：聊天和绘画使用独立的 Base URL、API Key、模型列表和当前模型，互不污染。
- **稍后配置**：未配置时也可以浏览和切换模式；只有发送聊天或生成图片时才会提示配置。
- **模型管理**：支持从 `/models` 刷新模型，也支持手动填写未出现在列表中的模型。
- **本地存储**：聊天数据保存在 `localStorage`；绘画历史图片体积较大，保存在 IndexedDB。
- **文件上传**：聊天支持图片和常见文本文件；绘画支持上传一张参考图进行编辑。
- **多主题和移动端**：支持深色/浅色主题和移动端响应式布局。

## 快速开始

直接打开 `index.html` 即可使用，也可以用任意静态服务器部署整个目录。

首次打开即可进入主界面。你可以稍后配置 API；未配置时，点击发送或生成会弹出对应配置窗口。

聊天配置：

1. 填写聊天 **Base URL**，例如 `https://api.openai.com/v1`。
2. 填写聊天 **API Key**。
3. 刷新或手动填写聊天模型。
4. 保存后即可聊天。

如果要使用绘画模式，进入「设置 -> 绘画」单独配置：

1. 填写 **Image Base URL**。
2. 填写 **Image API Key**。
3. 选择或手动填写绘画模型，默认推荐 `gpt-image-2`。
4. 如需映射模式，可选择或手动填写映射模型；留空表示关闭映射。

## 聊天模式

聊天模式支持：

- 新建、切换、重命名、删除会话
- 流式回复
- reasoning / thinking 内容折叠展示
- Markdown、代码块复制、表格、任务列表、图片链接
- 每个会话独立设置 Temperature、Top P、Max Tokens
- 上传图片、PDF、文本、代码等文件作为上下文
- 未配置时点击发送会打开聊天设置；设置窗口可以关闭，不会阻塞使用界面

聊天模式使用接口：

```text
POST /v1/chat/completions
GET  /v1/models
```

## 绘画模式

绘画模式支持两条路径：

- **文生图**：没有参考图时，调用 `/v1/images/generations`
- **参考图编辑**：上传参考图或从历史图片点击「以图编辑」时，调用 `/v1/images/edits`
- **映射生图/编辑**：配置映射模型后，会调用 `/v1/responses`，并要求模型调用 `image_generation` 工具；如有参考图，会把参考图作为 image input 一起发送

绘画模式支持：

- 独立绘画模型配置
- 尺寸、质量、格式、背景参数，默认尺寸为 `auto`
- 生成中等待状态、预计耗时提示，以及完成后的实际耗时
- 历史记录
- 图片点击放大
- 复制图片或图片链接
- 下载图片
- 从生成结果继续「以图编辑」
- 可选映射模型，可随时关闭并切回原 Images API
- 未配置时点击生成/编辑会打开绘画设置；设置窗口可以关闭，不会阻塞切换模式

目前绘画模式一次只生成一张图片。

### 映射模式说明

映射模式适合让一个通用模型通过工具来生成图片。启用后，OwnChat 会把绘画请求发送到 `/v1/responses`，并要求映射模型调用 `image_generation` 工具。

请求逻辑：

```text
用户提示词 / 参考图
  -> 映射模型
  -> tool_choice: required
  -> image_generation 工具
  -> 返回图片
```

注意：

- 映射模型不是直接生图，真正生成图片的是 `image_generation` 工具。
- 有参考图时，参考图会作为 `input_image` 一起发送给 Responses API。
- 如果关闭映射模型，会自动回到原来的 Images API 流程。
- 不是所有 OpenAI-compatible 服务都支持 Responses API 或 `image_generation` 工具。

## 存储说明

OwnChat 不会主动把配置和历史发送给除你配置的 API 服务之外的第三方。

本地存储分布：

- `localStorage`：聊天配置、聊天会话、绘画配置、主题、当前模式等轻量数据
- IndexedDB：绘画历史和图片数据

浏览器存储空间有限。绘画图片体积较大，如果历史保存失败，当前页面仍可查看刚生成的图片，但刷新后可能不会保留。

## OpenAI-Compatible 服务注意事项

不同 OpenAI-compatible 服务对 Images API 参数支持不完全一致。OwnChat 做了基础兼容：

- 如果绘画接口不支持 `quality`、`output_format`、`background`，会自动用更小的参数集重试一次。
- 如果映射模式下服务不支持 `tool_choice: "required"`，会尝试使用 `{ type: "image_generation" }` 形式重试。
- 如果服务返回图片 URL 而不是 base64，复制操作会复制图片链接；下载可能会由浏览器打开新链接。
- `/models` 不一定能区分聊天模型和绘画模型，因此聊天和绘画都支持手动填写模型名。

## 部署

这是静态项目，部署时只需要提供以下文件：

```text
index.html
style.css
app.js
README.md
```

可以直接放到任意静态托管服务、Nginx、Apache、GitHub Pages 或本地静态服务器中。

## 开发

项目结构：

```text
.
├── index.html   # 页面结构
├── style.css    # 样式和响应式布局
├── app.js       # 应用逻辑、API 请求、本地存储
└── README.md    # 项目说明
```

本项目没有构建步骤。修改文件后刷新浏览器即可。

如果需要本地服务，可以在项目目录运行任意静态服务器，例如：

```bash
php -S 127.0.0.1:8097
```

## 安全提示

- API Key 仅保存在浏览器本地，但本地浏览器环境并不等同于密钥保险箱。
- 不建议在公共或不可信设备上保存长期有效的 API Key。
- AI 输出可能不准确，请核实重要信息。
- 绘画和聊天请求会发送到你配置的 Base URL，请确认服务提供方可信。

## License

MIT
