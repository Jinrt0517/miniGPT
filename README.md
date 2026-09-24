# miniGPT

一个简洁的 Windows ChatGPT 快捷聊天窗口。按 **Alt + Space** 打开，再按一次隐藏；可以置顶在普通桌面窗口之上，同时继续使用其他程序。

## 功能

- 全局快捷键、托盘常驻、窗口置顶、浅色／深色／跟随系统。
- 每次从隐藏状态唤起默认开始新聊天；从右上角历史记录可以继续旧聊天。
- 使用当前电脑的 Codex 官方 ChatGPT 登录，动态读取账号支持的模型和思考强度。
- 流式回复、停止生成、Markdown、代码复制、中文输入法保护。
- 区域截图提问、粘贴图片；图片先放入待发送区，按发送才提交。
- 自定义快捷键、可选失焦隐藏、可选开机启动。

## 直接运行

打开发行包文件夹里的 **miniGPT.exe**。请保留旁边的 DLL、resources 和 locales 文件夹，不能只单独拷贝 exe。

需要 Windows 10/11 x64，并已安装可运行的 Codex CLI 或 Codex 桌面应用。miniGPT 会查找 PATH 中的 `codex.exe` 和 Codex 桌面应用常用安装目录，也可以在设置里填写完整路径。

首次启动会检查现有官方登录。未登录时，在设置中点击「登录 ChatGPT」，在官方浏览器页面自行完成登录。miniGPT 不要求复制密码、Cookie 或访问令牌，也不会读取凭据文件。

### 快捷操作

| 操作 | 用法 |
| --- | --- |
| 打开／隐藏 | `Alt + Space`，可在设置中更改 |
| 新对话 | 每次重新唤起默认新开，或点击 `+`／`Ctrl + N` |
| 历史续聊 | 点击顶部历史图标，再选择对话 |
| 置顶 | 点击顶部图钉；已开启时按钮高亮 |
| 发送／换行 | `Enter`／`Shift + Enter` |
| 隐藏窗口 | `Esc`；若设置面板打开则先关闭面板 |
| 粘贴图片 | 输入框内 `Ctrl + V` 或粘贴图片按钮 |
| 区域截图 | 点击截图按钮，拖动框选，`Esc` 取消 |
| 完全退出 | 托盘菜单「退出 miniGPT」或设置中的退出按钮 |

如果 `Alt + Space` 被豆包、ChatGPT、PowerToys 等程序占用，miniGPT 会明确显示冲突。请在冲突程序中释放该组合，或给 miniGPT 设置其他快捷键。miniGPT 不会修改其他程序的设置。

置顶适用于普通 Windows 桌面窗口；UAC 安全桌面和部分独占全屏程序不受普通应用的置顶控制。显示小窗会将键盘焦点切换到 miniGPT，不会暂停、最小化或终止其他程序。

## 订阅、对话与数据

本软件通过 [Codex App Server](https://learn.chatgpt.com/docs/app-server) 和[官方 ChatGPT 登录](https://learn.chatgpt.com/docs/auth)使用账号的 **Codex 权益与额度**。模型列表、思考档位、限额以官方服务的实际返回为准。它是独立的聊天界面，不是 ChatGPT 网页的完整替代品，也不与网页聊天记录同步。本版不接受 API-key 模式，避免无意切换到单独计费。

发行版设置和聊天保存在 `%APPDATA%\miniGPT`；源码开发模式保存到项目 `.local-data`。已发送的图片也会保存在本地历史中，以便重新启动后继续对话。待发送截图只保存在内存中。删除历史会删除本应用的对应本地记录，不修改其他 Codex 或 ChatGPT 会话。该目录属于本机用户数据，不应提交到 GitHub。

后端创建无工具、无执行环境的临时会话，拒绝工具和权限请求。重启后会用本应用保存的可见消息和附件重新建立上下文；不恢复模型内部隐藏状态。极长的历史或超大的附件超过恢复限制时会明确报错。

本版专注普通对话和图片理解，不提供联网搜索或电脑操作。截图当前支持鼠标所在的一个显示器内框选。

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
npm run pack
```

打包结果为 `dist/miniGPT-win32-x64/miniGPT.exe`。开机启动仅在打包版中可启用。

`test:desktop` 在隐藏的测试窗口中读取当前登录的账号和模型，数据写入 `.test-data/integration`。设置 `MINIGPT_LIVE_TEST=1` 后才会执行两条简短的真实订阅聊天测试；默认不发送聊天请求。

项目内包含协议分包、超时、隔离配置、取消、历史恢复、附件恢复、计费模式和设置校验的自动化测试。UI 渲染使用本地打包的 marked 和 DOMPurify，远程内容没有 Node.js 权限。

功能参考及证据范围见 [豆包桌面小窗调研](docs/doubao-reference.md)。本项目与 OpenAI、豆包均无官方隶属关系。
