# miniGPT

一个简洁的 Windows ChatGPT 快捷聊天窗口。按 **Alt + Space** 打开，再按一次隐藏；可以置顶在普通桌面窗口之上，同时继续使用其他程序。

[下载 v0.1.0](https://github.com/Jinrt0517/miniGPT/releases/tag/v0.1.0) · [更新记录](CHANGELOG.md) · [实现说明](docs/architecture.md)

## 功能

- 全局快捷键、托盘常驻、窗口置顶、浅色／深色／跟随系统。窗口不显示任务栏图标，也不进入 Alt + Tab 列表。
- 每次从隐藏状态唤起默认开始新聊天；从右上角历史记录可以继续旧聊天。
- 使用当前电脑的 Codex 官方 ChatGPT 登录，动态读取账号支持的模型和思考强度。
- 模型和思考强度选择器适配浅色、深色和紧凑窗口，支持键盘操作，并记住上次选择。
- 流式回复、停止生成、Markdown、代码复制、中文输入法保护。
- 粘贴图片；图片先放入待发送区，按发送才提交。
- 历史记录按标题搜索、继续对话、单条删除和确认清空全部历史。
- 新聊天欢迎页显示在线语录，包含类别、出处和原文链接；网络不可用时可使用本地缓存。
- 自定义快捷键、可选失焦隐藏、跟随鼠标所在屏幕、可选开机启动。
- 保存窗口位置、大小与最大化状态，下次启动自动恢复；可切换紧凑窗口。

## 直接运行

从 [v0.1.0 Release](https://github.com/Jinrt0517/miniGPT/releases/tag/v0.1.0) 下载 **miniGPT-v0.1.0-win32-x64.zip**，完整解压后打开文件夹里的 **miniGPT.exe**。请保留旁边的 DLL、resources 和 locales 文件夹，不能只单独拷贝 exe。

可同时下载 Release 中的 `SHA256SUMS.txt`，在下载目录运行以下命令，将输出的 SHA256 与文件中对应 ZIP 的值比较：

```powershell
Get-FileHash .\miniGPT-v0.1.0-win32-x64.zip -Algorithm SHA256
```

需要 Windows 10/11 x64，并已安装可运行的 Codex CLI 或 Codex 桌面应用。miniGPT 会查找 PATH 中的 `codex.exe` 和 Codex 桌面应用常用安装目录，也可以在设置里填写完整路径。

首次启动会检查现有官方登录。未登录时，在设置中点击「登录 ChatGPT」，在官方浏览器页面自行完成登录。miniGPT 不要求复制密码、Cookie 或访问令牌，也不会读取凭据文件。

### 快捷操作

| 操作 | 用法 |
| --- | --- |
| 打开／隐藏 | `Alt + Space`，可在设置中更改 |
| 新对话 | 每次重新唤起默认新开，或点击 `+`／`Ctrl + N` |
| 历史续聊 | 点击顶部历史图标，可按标题搜索，再选择对话 |
| 删除历史 | 点击对话旁的垃圾桶立即删除；点击底部「清空历史记录」并确认可删除全部历史 |
| 置顶 | 点击顶部图钉；置顶时实心，未置顶时空心 |
| 模型／思考强度 | 点击输入框下方的选择器；方向键移动，Home／End 跳到首尾，Enter／空格选择，Esc 收起 |
| 发送／换行 | `Enter`／`Shift + Enter` |
| 停止生成 | 发送后按钮变为 `Ⅱ`，点击可停止等待或生成中的回复 |
| 隐藏窗口 | `Esc`；优先关闭当前选择器、历史／设置面板或清空确认框 |
| 粘贴图片 | 复制图片后，在输入框内 `Ctrl + V`；发送前可从待发送区移除 |
| 紧凑窗口 | 点击右下角展开／收起按钮；发送消息时自动展开 |
| 查看语录出处 | 点击欢迎页语录下方的来源，在系统浏览器中打开原文 |
| 完全退出 | 托盘菜单「退出 miniGPT」或设置中的退出按钮 |

如果 `Alt + Space` 被豆包、ChatGPT、PowerToys 等程序占用，miniGPT 会明确显示冲突。请在冲突程序中释放该组合，或给 miniGPT 设置其他快捷键。miniGPT 不会修改其他程序的设置。

置顶适用于普通 Windows 桌面窗口；UAC 安全桌面和部分独占全屏程序不受普通应用的置顶控制。显示小窗会将键盘焦点切换到 miniGPT，不会暂停、最小化或终止其他程序。

在浏览器全屏或网页视频全屏时唤起，miniGPT 会尝试让同一屏幕的任务栏保持在全屏内容后方。它仅调整自身窗口的 Windows shell 标记，不隐藏或修改系统任务栏。miniGPT 仅保留托盘图标，可以通过快捷键或托盘打开。开启「失去焦点时隐藏」后，窗口仅在未置顶时随失焦隐藏。

重启应用会恢复上次保存的位置和大小，包括紧凑窗口与最大化状态。隐藏后在同一屏幕再次唤起也会保留位置；打开设置不会重新居中。若原显示器已断开，会将窗口调整到可见区域。开启「跟随鼠标所在屏幕」时，普通窗口跨显示器唤起会尽量保留相对位置，启动时优先恢复上次保存的位置。

隐藏窗口后，正在生成的回复可以继续完成；再次唤起会开始新对话，并停止尚未完成的旧回复。生成中请先停止回答，再切换对话或清空历史。单条删除无需二次确认；「清空历史记录」会删除全部记录，包括当前搜索没有显示的对话。删除失败时记录保留，可重试。

## 欢迎页语录

每次新聊天从哲思、文学、影视、游戏、动画、原创、诗词七类中轮换获取语录，优先使用[一言](https://hitokoto.cn/)，遇到重复或服务不可用时尝试[中文维基语录](https://zh.wikiquote.org/)。点击出处可以核对原文；内容与署名以来源站点为准。

语录不是模型生成，也不消耗 Codex 对话额度。应用会保存最近使用记录和最多 250 条语录缓存，尽量减少重复；离线或服务不可用时可能重复使用缓存，没有缓存则显示离线提示。在线语录没有保证每次都能更新。

## 订阅、对话与数据

本软件通过 [Codex App Server](https://learn.chatgpt.com/docs/app-server) 和[官方 ChatGPT 登录](https://learn.chatgpt.com/docs/auth)使用账号的 **Codex 权益与额度**。模型列表、思考档位、限额以官方服务的实际返回为准。它是独立的聊天界面，不是 ChatGPT 网页的完整替代品，也不与网页聊天记录同步。本版不接受 API-key 模式，避免无意切换到单独计费。

发行版设置和聊天保存在 `%APPDATA%\miniGPT`；源码开发模式保存到项目 `.local-data`。设置为 `settings.json`，窗口状态为 `window-state.json`，语录缓存为 `welcome-quotes.json`，聊天及已发送附件为 `conversations/conversations.json`。测试可以通过 `MINIGPT_DATA_DIR` 使用独立目录。

已发送的图片也会保存在本地历史中，以便重新启动后继续对话；待发送图片只保存在内存中。历史文件未加密，应按个人聊天数据保管，不应提交到 GitHub。删除历史会删除本应用的对应记录和附件，不修改其他 Codex 或 ChatGPT 会话，也不清除设置与语录缓存。

消息和已发送图片通过官方 Codex 服务处理。欢迎页会另外请求 `v1.hitokoto.cn`，必要时请求 `zh.wikiquote.org`；语录请求不包含聊天内容、图片或账号信息。应用没有全局剪贴板监听，仅在用户粘贴图片时读取剪贴板。

后端创建无工具、无执行环境的临时会话，拒绝工具和权限请求。重启后会用本应用保存的可见消息和附件重新建立上下文；不恢复模型内部隐藏状态。极长的历史或超大的附件超过恢复限制时会明确报错。

本版专注普通对话和图片理解，聊天不提供联网搜索或电脑操作。图片需要当前模型支持图片输入；每条消息最多 8 个附件，过大的图片或历史会提示限制。当前界面通过粘贴添加图片，不提供文件上传按钮或拖放导入。

## 开发与打包

需要 Node.js 22.12+、npm 或 pnpm，以及支持 `environments: []` 的近期 Codex CLI。本项目已使用 `codex-cli 0.155.0-alpha.16.4` 联调。

```powershell
npm install
node node_modules/electron/install.js
npm run build:assets
npm start
```

使用 pnpm 时，若安装策略未运行 Electron 的安装脚本，也需要显式运行上面的 `install.js`。

```powershell
npm test
npm run test:desktop
npm run test:generation-controls
npm run test:selection-controls
npm run test:window-state
npm run test:taskbar
npm run test:history
npm run pack
```

打包结果为 `dist/miniGPT-win32-x64/miniGPT.exe`。开机启动仅在打包版中可启用。

发布时可运行 `npm run pack -- --release`，输出到 `dist/miniGPT-v0.1.0-win32-x64/`，避免覆盖正在运行的本地成品。设置 `MINIGPT_TEST_EXECUTABLE` 为该目录中 exe 的完整路径后，可用 `test:chat`、`test:clipboard -- --synthetic`、`test:window-state` 和 `test:taskbar` 验证这个发行包。

Windows 源码启动和打包时会使用系统自带的 .NET Framework C# 编译器生成任务栏辅助程序；发行包已包含它，无需额外安装依赖。

`test:desktop` 在隐藏的测试窗口中读取当前登录的账号和模型，数据写入 `.test-data/integration`。设置 `MINIGPT_LIVE_TEST=1` 后才会执行两条简短的真实订阅聊天测试；默认不发送聊天请求。

完成打包后可运行 `npm run test:chat`，在成品中发送三条真实订阅请求，检查文字回复、历史续聊和粘贴图片识别。测试使用独立的 `.test-data/check-chat` 目录与合成红色图片，不读取或覆盖系统剪贴板；会使用账号的少量 Codex 额度。

图片粘贴回归检查：先复制一张图片，再运行 `npm run test:clipboard`。它在隐藏窗口中只读验证当前系统剪贴板和真实粘贴事件，不覆盖剪贴板、不保存图片或发送聊天。剪贴板读取使用当前 Electron 的异步 `ClipboardItem` 接口。运行 `npm run test:clipboard -- --synthetic` 可使用合成图片测试粘贴，无需读取系统剪贴板。

`test:history` 在独立测试目录中验证单条删除、清空确认、取消、失败重试和生成中的保护，不修改现有历史或发送聊天。

`test:generation-controls` 使用受控 IPC 时序验证停止图标、发送等待期间取消、停止请求去重和完成后的恢复。`test:selection-controls` 验证模型／思考强度选择、键盘操作、禁用状态、主题、紧凑窗口滚动与图钉样式。这两项在隐藏窗口中运行，不发送聊天。

`test:window-state` 使用独立测试目录和隐藏窗口验证设置面板、紧凑模式、退出重启、位置大小恢复与同屏反复唤起，不修改现有窗口设置。

`test:taskbar` 会短暂显示独立全屏测试窗口，检查任务栏图标、全屏唤起、键盘输入和普通窗口下的任务栏恢复，结束后自动关闭测试窗口。它使用独立测试数据，不发送聊天。

项目内包含协议分包、超时、隔离配置、取消、历史恢复、附件恢复、计费模式、设置校验、窗口状态和语录缓存的自动化测试。语录单元测试使用模拟响应，验证七类轮换、来源切换、离线缓存和文本提取；它不代表外部语录站点实时可用。桌面测试会启动真实应用，部分启动流程仍可能读取本机登录状态或请求在线语录；“不发送聊天”不表示完全断网运行。

UI 渲染使用本地打包的 marked 和 DOMPurify，远程内容没有 Node.js 权限。代码结构、数据流和隔离边界见 [实现说明](docs/architecture.md)。

功能参考及证据范围见 [豆包桌面小窗调研](docs/doubao-reference.md)。本项目与 OpenAI、豆包均无官方隶属关系。
