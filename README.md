# Codex-to-IM

[English](README_EN.md)

`codex-to-im` 是一个本地桥接应用，用来把 Codex 接到飞书、微信等 IM 通道中使用。

它的主路径不是“改造 Codex 本体”，而是：

1. 在本机启动一个 Web 工作台和 bridge
2. 在工作台中新增并配置一个或多个通道实例
3. 把桌面里的 Codex 会话接到 IM
4. 在 IM 中继续对话、切线程、查看状态

## 核心能力

- 共享桌面线程：把 Codex Desktop 中正在使用的 thread 绑定到 IM，在 IM 中继续同一条会话。
- IM 远程操作：支持查看当前状态、切线程、新建线程、切模式、切思考级别、切模型、停止当前任务、查看历史等常用命令。
- 本地 Web 工作台：集中完成配置、通道登录、日志查看、会话管理和绑定管理。
- 飞书流式卡片：飞书侧支持流式展示共享线程回复，也支持工具进度展示。
- 附件回传：支持把本地图片或文件发回到飞书；如果需要让 Codex 主动使用这个能力，可以安装仓库附带的 `codex-to-im` skill。
- 本地优先：服务、配置、日志和 bridge 都运行在本机，可选开启局域网访问 Web 控制台。

## 支持的通道

- 飞书：支持创建多个机器人实例、连通性测试、共享线程、流式卡片、图片和文件发送。
- 微信：支持创建多个实例、扫码登录、共享线程和文本反馈。

每个通道实例都可以配置自己的别名，例如：

- `飞书主号`
- `飞书备份号`
- `微信工作号`

这些别名只用于区分不同聊天入口，不会改变 Codex 会话本身的语义。

## 快速开始

### 依赖

- Node.js 20+
- 当前系统用户下可用的 Codex 登录态或 API 凭据

满足以下任一条件即可：

- 已登录 Codex Desktop App
- 已登录 Codex CLI
- 已配置 `CTI_CODEX_API_KEY`、`CODEX_API_KEY` 或 `OPENAI_API_KEY`

### 安装

```bash
npm install -g codex-to-im
```

### 启动

```bash
codex-to-im
```

如果只想启动后台 bridge，不打开 UI：

```bash
codex-to-im start
```

### 开机自启动（Windows）

当前支持把 **bridge** 注册为 Windows 开机启动任务，UI 仍然按需通过 `codex-to-im` 打开。

```powershell
codex-to-im autostart status
codex-to-im autostart install
codex-to-im autostart uninstall
```

说明：

- `codex-to-im autostart install` 和 `codex-to-im autostart uninstall` 需要在**管理员 PowerShell / 终端**中执行。
- 安装时会要求输入当前 Windows 登录密码，用于创建开机任务。
- 自动启动只拉起 bridge，不会自动打开 Web UI。
- 手动再次执行 `codex-to-im` 只会补启动 UI，不会重复启动 bridge。
- 当前实现基于 Windows 自带任务计划程序，不依赖 WinSW、NSSM 等第三方组件。
- Web 工作台现在只展示自动启动状态；真正的启用和关闭请使用上面的管理员命令。

默认会打开本地工作台：

```text
http://127.0.0.1:4781
```

如果想查看当前地址或运行状态：

```bash
codex-to-im url
codex-to-im status
```

如果要停止本地 UI 和 bridge：

```bash
codex-to-im stop
```

## 典型使用方式

### 1. 接管桌面线程

在 Web 工作台里新增好飞书或微信通道实例后，启动 bridge。  
然后在 IM 中发送：

```text
/t
```

查看最近 10 条桌面线程，发送：

```text
/t all
```

查看最多 200 条桌面线程。  
再通过：

```text
/t 1
```

切到对应线程。

### 2. 在 IM 中继续对话

绑定成功后，直接发送普通消息即可继续当前线程。  
桌面继续操作这条共享线程时，结果也会同步到 IM。

### 3. 新建 IM 线程

```text
/new
```

会在当前正式会话的工作目录下新建线程。  
如果当前没有正式会话，或当前是临时线程，会直接报错。

也可以显式指定目录：

```text
/new my-project
/new D:\work\my-project
```

## 常用命令

- `/` 或 `/status`：查看当前会话、线程、模型、模式、思考级别、共享镜像状态。
- `/t`：查看最近 10 条桌面线程。
- `/t all`：查看最多 200 条桌面线程。
- `/t n 100`：查看最近 100 条桌面线程，最多 200 条。
- `/t 1`：切换到第 1 条桌面线程。
- `/t 0`：切换到当前聊天的临时线程。
- `/new`：在当前正式会话目录下新建线程。
- `/new <路径或项目名>`：按指定目录新建线程。
- `/mode <ask|code>`：切换运行模式。
- `/reasoning <1-5>`：切换思考级别。
- `/model`：查看当前模型和可选模型。
- `/model <模型名>`：切换当前 IM 会话模型。
- `/history`：查看当前线程历史摘要。
- `/stop`：停止当前任务。
- `/unbind`：解除当前聊天与会话的绑定。

## 关键配置

工作台里的常用配置主要有：

- 默认工作空间：用于 `/new my-project` 这类相对路径。
- Codex 文件系统权限：如 `workspace-write`、`danger-full-access`。
- Codex 思考级别：`1-5`。
- 默认模型：从本机可用模型中选择。
- 反馈使用 markdown：控制 bridge 发到通道里的文本反馈是否走 markdown。
- 允许局域网访问 Web 控制台：便于手机或局域网设备访问。
- 通道实例：可以为飞书或微信新增多个机器人/账号入口，并给每个实例设置别名。

当前主配置保存在：

- `~/.codex-to-im/config.v2.json`

兼容保留的 `config.env` 只作为快照和旧工具兜底，不再完整表示多实例通道配置。

## 当前边界

- `/new` 创建的是 IM 线程，当前只保证在 IM 中可继续；不保证会自动出现在 Codex Desktop 会话列表中。
- 一个会话只能绑定一个聊天，跨飞书/微信也互斥。
- 飞书附件当前支持图片和文件；视频目前按文件发送，不承诺原生预览。
- `/t` 默认只显示最近 10 条桌面线程；`/t all` 最多返回 200 条，`/t n 100` 也最多返回 200 条。

## 更多文档

- Windows 安装说明：[docs/install-windows.md](docs/install-windows.md)
- 英文文档：[README_EN.md](README_EN.md)
