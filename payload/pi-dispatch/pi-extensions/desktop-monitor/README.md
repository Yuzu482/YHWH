# Pi 桌面监控

[![简体中文](.readme-assets/zh.svg)](README.md) [![English](.readme-assets/en.svg)](README.en.md)

这是随 Pi Dispatch 分发的 Windows Pi 扩展。在 Pi 中运行 `/pi-monitor`，即可打开独立、可调整大小、可拖动且默认置顶的窗口。取消勾选“置顶”可关闭置顶。关闭 Pi 或切换 Codex 对话不会决定该窗口的生命周期；关闭窗口只停止它专用的只读数据进程。按用户和会话创建的互斥锁可防止同一 Gateway 出现重复窗口。

将此目录作为本地 Pi 包安装，并保留在 Pi Dispatch 内，以便数据进程复用已安装的 MCP SDK 和回环地址凭据读取器。宿主 Gateway 必须已运行。配置来自 `PI_GATEWAY_CONFIG`，未设置时使用 `~/.local/state/pi-kether/gateway-silent.json`。扩展只在 Windows 宿主运行，不进入 WSL 子代理沙箱。

读取器只调用 `list_subagents`，最多显示 50 条脱敏状态记录，不派发模型，也不向 UI 暴露凭据。正常每两秒刷新，连接出错时退避至十五秒。不增加未认证端点、自动启动钩子、权限变更或遥测。UI 进程以无控制台方式启动，只显示用户请求的窗口。

独立启动方式（宿主代理也可使用）：

```text
node <installed-pi-dispatch>/pi-extensions/desktop-monitor/launcher.mjs
```

## 显示控制

浅色面板显示连接健康状态、运行与排队数量，以及 Gateway RSS。任务卡片按状态着色，提供可读时长，并用悬停提示展示较长的 ID 和模型名。“仅活动任务”筛选隐藏已结束任务。紧凑模式将任务列表折叠为 260 像素高的概览，展开后恢复高度。重新连接时保留最近更新时间和数据过期提示。布局定义在 `window.xaml`，分发时必须与 `window.ps1` 放在一起。

## 独立迷你宠物

运行 `/pi-pet` 可打开 320 × 100 的迷你陪伴窗口；`/pi-monitor` 仍打开完整面板。两者共用一个窗口、一条 Gateway 数据流和一个单实例互斥锁。窗口已打开时，使用窗口控件切换模式，命令不会重复创建窗口。安装更新后，应重新加载已有 Pi 会话。

原创矢量表情与圆角胶囊外观借鉴紧凑悬浮控件。这是 Pi 的陪伴窗口，不是 ChatGPT 原生宠物的扩展；不需要图片生成、复制应用资源、模型调用或新增凭据。宠物只呈现计数与脱敏状态。

- 点击表情或状态可展开；点击“宠物”或按 Escape 可折叠。
- 拖动点状握柄可移动，位置保持在虚拟桌面范围内。
- 三点菜单或右键菜单提供展开、置顶、动画和退出选项。
- 运行和排队时轻微脉动，空闲或错误时静止。动画可关闭，并遵循 Windows 客户端区域动画设置。
- 优先显示运行数量。历史失败明确标注为“近期有失败 / 近期失败”，不表示活动任务仍在失败。
- 断开连接显示问号，不显示虚假的零任务或成功状态。
- 退出只关闭监控及其数据进程，已有 Pi 任务继续执行。

分发时将 `pet.ps1`、`window.xaml` 与 `window.ps1` 一并提供。Windows PowerShell 脚本使用带 BOM 的 UTF-8，子进程状态流显式按 UTF-8 解码。独立宠物启动命令：

```text
node <installed-pi-dispatch>/pi-extensions/desktop-monitor/launcher.mjs --pet
```

迷你窗口采用受 iOS 启发的浅色悬浮表面、柔和阴影、圆角蓝色头像、高对比度状态徽章及配套浅色菜单。这是 WPF 外观处理，不是原生 iOS 材质或背景模糊。

宠物和展开面板共用 `window.xaml` 中的 FloatingSurface、头像填充、按钮样式和状态画刷。`Get-StateTheme` 为宠物指示器和任务卡片提供统一的状态颜色映射。紧凑面板高度为 260 像素，给共享悬浮表面周围的页脚保留空间。

## 窗口过渡

宠物、完整面板和紧凑面板之间的切换先执行 70 ms 淡出，随后执行 200 ms 视觉缩放（97.5% → 100%）和 220 ms 淡入，使用三次缓出。窗口布局只在隐藏时更改一次，不逐帧调整原生窗口尺寸。

快速请求合并为最新待处理状态。拖动或关闭动画会立即结束当前过渡。关闭窗口会清理动画时钟及待处理工作。现有动画菜单和 Windows 客户端区域动画设置同时控制过渡与宠物脉动。启动及减少动态效果模式直接切换。上述时长是配置值，不保证每台主机的帧率。

分发时将 `transitions.ps1` 与其他 UI 文件一并提供。Windows UI 回归检查：

```text
powershell.exe -NoProfile -STA -File <pi-dispatch>/tests/desktop-monitor-transitions.ps1
```

该检查会打开临时验证窗口，不使用模型或 Gateway。
