# 实现说明

miniGPT 的渲染层使用本地 HTML/CSS/JavaScript；Electron 主进程负责全局快捷键、窗口、托盘和图片剪贴板。渲染进程启用 sandbox 与 contextIsolation，不开放 Node.js，仅能调用 preload 中的有限 IPC 接口。

主进程通过 stdio JSONL 与本机官方 `codex app-server` 通信。登录由官方进程管理。账号返回值只取账号类型、邮箱和订阅类型；不会把令牌、原始错误日志或执行通道传给界面。

模型与 reasoning effort 来自 `model/list`，发送前再次校验；不维护写死的模型菜单。只有 ChatGPT 登录模式允许发送。本地设置使用临时文件后原子改名保存；每段聊天拥有本应用生成的 ID，不接受其他 Codex 会话 ID。

为纯聊天限制执行能力：禁用 shell、code mode、浏览器、计算机控制、MCP、插件、hooks 等功能；为继承的 MCP 逐个设置 disabled；thread 与 turn 均明确使用空 environments；只读、无网络执行沙箱；拒绝服务端工具与审批请求。模型服务自身的联网连接不属于执行沙箱的网络访问。

MCP 禁用配置通过嵌套对象 `mcp_servers: { [name]: { enabled: false } }` 合并到原配置。App Server 的 JSON 覆盖不解析 TOML 引号路径；配置读取结果中的可选空值也不能直接回写为 TOML，所以这里只覆盖启用标志，保留原服务器名称和连接配置。

每次唤起发出 `new-conversation` 事件，新对话不会被旧流式事件覆盖。隐藏过程中仍可完成当前回答；重新唤起若旧回答还在生成，会停止它并开始新聊天。历史列表始终可以打开已有记录继续。重启后，以历史可见文本和图片重建隔离的临时会话。

用户在输入框粘贴图片或点击粘贴图片按钮时，图片先成为待发送附件，按发送后才进入聊天请求。应用没有监听全局剪贴板。
