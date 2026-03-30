# Codex-to-IM Windows 安装说明

## 1. 当前部署方案

`codex-to-im` 当前采用的是 **单 npm 包 + 本地 Web 工作台 + 本地后台 bridge** 的部署方案。

补充说明：当前版本不是从零开始的新工程，而是在旧桥接原型基础上整理和演进而来。

核心形态如下：

- 分发物：`codex-to-im` npm 包
- 启动入口：全局命令 `codex-to-im`
- 本地界面：优先 `http://127.0.0.1:4781`，被占用时自动切换到可用端口
- 后台进程：
  - `dist/ui-server.mjs` 负责本地工作台
  - `dist/daemon.mjs` 负责 bridge
- 运行方式：本地 Node.js detached 子进程，不依赖当前命令窗口常驻
- 配置目录：`%USERPROFILE%\\.codex-to-im\\`

这意味着当前推荐的部署方式不是“clone 仓库后让用户手动跑脚本”，而是：

1. 发布一个已经构建好的 npm 包
2. 在目标 Windows 主机全局安装
3. 运行 `codex-to-im`

可选：如果你希望 Codex 在不依赖 bridge 注入提示词的前提下，知道“可以把本地图片/文件回发到 IM”，可以在工作台里安装附带的 `codex-to-im` skill。
4. 在浏览器里完成配置、测试和启动

## 2. 适用前提

下面这份说明按 **Windows 主机** 写。

默认假设：

- 目标机是 Windows 10 / 11
- 目标机已经安装 Node.js 20+
- 目标机使用同一个 Windows 用户来运行 Codex 和 `codex-to-im`
- 飞书应用、微信账号等平台侧信息已经准备好

## 3. 安装前准备

目标机至少需要这些前置条件：

### 3.1 安装 Node.js

要求：

- Node.js >= 20

建议安装完成后检查：

```powershell
node -v
npm -v
```

### 3.2 准备 Codex 认证

如果你希望 bridge 接管和继续 Codex 会话，目标机必须在 **同一个 Windows 用户** 下完成 Codex 登录。

建议至少满足以下之一：

- 已安装并使用过 Codex Windows App
- 已有可用的 Codex CLI 登录态
- 已配置可用的 API Key（`CTI_CODEX_API_KEY`、`CODEX_API_KEY` 或 `OPENAI_API_KEY`）

说明：

- `codex-to-im` 现在已经随包带上运行 bridge 所需的 `@openai/codex-sdk` / Codex CLI 平台依赖
- 这意味着目标机为了运行 bridge，本身不再强制要求额外全局安装一份 Codex CLI
- 但如果这台机器还没有任何 Codex 登录态，最直接的补齐方式仍然是装一次全局 CLI 完成登录

如果目标机还没有 Codex 登录态，建议执行：

```powershell
npm install -g @openai/codex
```

然后完成登录：

```powershell
codex auth login
```

## 4. 目标机安装方式

### 4.1 推荐：从 npm 全局安装

如果包已经发布到 npm：

```powershell
npm install -g codex-to-im
```

安装完成后，直接启动：

```powershell
codex-to-im
```

### 4.2 备用：从源码安装

如果还没有正式发布 npm 包，可以在目标机直接用源码：

```powershell
git clone <your-repo-url> D:\codex\codex-to-im
cd D:\codex\codex-to-im
npm install
npm run build
node dist\cli.mjs open
```

如果希望源码安装后也能直接使用 `codex-to-im` 命令，可以再执行：

```powershell
npm link
```

## 5. 首次启动

首次启动命令：

```powershell
codex-to-im
```

当前行为是：

1. 拉起本地 UI 服务
2. 在后台运行 `ui-server`
3. 自动打开浏览器到本地工作台

默认地址：

```text
http://127.0.0.1:4781
```

如果 `4781` 已被占用，程序会自动查找一个可用端口，并在启动时把实际地址打印到命令行。

默认情况下，Web 工作台只允许本机访问。

如果你要在手机或局域网其他设备上打开配置页，可以在“配置”页里勾选“允许局域网访问 Web 控制台”。开启后：

- 工作台会显示当前可用的局域网地址
- 工作台会显示访问 token
- 局域网设备访问时会先看到登录页，输入 token 后才能进入工作台
- 也可以直接复制工作台里的局域网登录链接，链接中会附带 `?token=...`

如果之后忘记了当前 Web 地址，可以执行：

```powershell
codex-to-im url
```

查看当前本地服务状态：

```powershell
codex-to-im status
```

如果只想启动后台 bridge，不打开 Web 工作台：

```powershell
codex-to-im start
```

停止后台 UI 和 bridge：

```powershell
codex-to-im stop
```

可选：启用 Bridge 开机自启动（只自动启动 bridge，不自动打开 UI）：

```powershell
codex-to-im autostart status
codex-to-im autostart install
codex-to-im autostart uninstall
```

请先以**管理员身份**打开 PowerShell / 终端，再执行上面的安装或卸载命令。

启用时会要求输入当前 Windows 登录密码，用于创建“开机自动启动 Bridge”的任务计划程序任务。

Web 工作台现在只展示自动启动状态；真正的启用和关闭请使用上面的管理员命令。

## 6. 在目标机上的首次配置

进入本地工作台后，按这个顺序做：

1. 选择 `Runtime`
   - 推荐：`codex`
2. 设置 `/history` 默认返回条数（可选）
3. 设置默认工作空间
   - 用于 `/new proj1` 这类相对项目名
   - 留空时自动回退到 `~/cx2im`，并按当前系统展开为实际路径
4. 选择 Codex 文件系统权限
   - 默认推荐 `workspace-write`
5. 选择 Codex 思考级别
   - 默认推荐 `medium`
   - 官方仅有 5 个级别：`minimal`、`low`、`medium`、`high`、`xhigh`
   - 如果这台机器就是你自己的本地开发机，希望 `codex-to-im` 直接承担更强的编码执行能力，建议改成：
     - 文件系统权限：`danger-full-access`
     - 思考级别：`xhigh`
6. 如果目标目录不是 Codex 已信任的 Git 仓库，可勾选“允许在未信任 Git 目录运行 Codex”
7. 如果要从局域网设备访问配置页，可勾选“允许局域网访问 Web 控制台”
8. 打开“通道”页，新增一个通道实例
   - 先选择 Provider：`飞书` 或 `微信`
   - 再为该实例填写一个别名，例如：`飞书主号`、`飞书备份号`、`微信工作号`
9. 飞书实例填写：
   - `App ID`
   - `App Secret`
- `站点`：选择 `Feishu` 或 `Lark`
   - `Allowed Users` 可选
   - `启用飞书流式响应卡片` 可选
10. 微信实例点击：
   - `开始微信扫码`
11. 点击当前实例的测试按钮
   - 飞书实例：`测试当前通道`
   - Codex：`测试 Codex`
12. 点击：
   - `启动 Bridge`

说明：

- 飞书流式响应卡片依赖飞书应用侧具备可更新卡片 / CardKit 相关能力。
- 当前至少需要并发布这些权限：
  - `cardkit:card:write`
  - `cardkit:card:read`
  - `im:message:update`
- 如果这些权限没有开通，桥接仍然可以工作，但会回退到最终结果消息。
- 缺权限时，`logs\\bridge.log` 里通常会出现 `99991672` 和 `cardkit:card:write`。
- 另外，当前 `codex` runtime 下正文通常不是逐字流式输出；更常见的效果是先显示 `Thinking / Tool Progress`，正文在回答完成时一次性落到卡片里。
- IM 里发送 `/history` 可以查看当前会话最近 N 条消息，N 由“基础配置”中的返回条数控制。
- IM 里发送 `/history` 默认返回整理后的摘要；发送 `/history raw` 才会查看最近 N 条原始消息。
- IM 里发送 `/reasoning high` 或 `/reasoning 4` 之类命令，可以只对当前会话覆盖思考级别。
- IM 里发送 `/thread 0` 会进入临时草稿线程，适合短讨论或临时想法。
- “通道”页现在管理的是多个通道实例，而不是固定的一组飞书/微信配置。
- 每个实例都可以有自己的别名；别名只用于区分不同聊天入口，不会改变 Codex 会话语义。
- “反馈使用 Markdown”也是实例级配置：
  - 飞书实例默认开启
  - 微信实例默认关闭
  - 影响通过 bridge 发送到该实例的文本反馈，包括普通回复、共享桌面线程镜像以及 `/h`、`/status`、`/threads` 这类系统反馈
- IM 里也支持一组短命令别名：
- `/` / `/status` 当前会话
- `/h` / `/help` 帮助
- `/t` / `/threads` 最近 10 条桌面会话，`/t all` / `/threads all` 最多查看 200 条，`/t n 100` / `/threads n 100` 查看最近 100 条（同样最多 200 条），`/t 1` / `/thread 1` 接管
- `/n` / `/new` 在当前正式会话目录下新建线程；这类线程当前只保证在 IM 中可继续，不会自动出现在 Codex Desktop 会话列表中
- `/n proj1` / `/new proj1` 新建项目会话
- `/m` / `/mode` 查看或切换模式，可选 `code` / `plan` / `ask`
- `/r` / `/reasoning` 查看或切换思考级别，也支持 `1|2|3|4|5`
- `/his` / `/history` 历史摘要，`/his raw` / `/history raw` 原始记录
- `/t 0` / `/thread 0` 临时草稿线程
- 如果 `测试 Codex` 失败，优先检查当前 Windows 用户下是否已经存在可用的 Codex 登录态或 API Key。
- 如果开启了局域网访问，建议直接从本机工作台复制局域网登录链接，再发给手机或其他设备打开。

## 7. 目标机上的目录说明

当前版本主要使用这些目录：

### 7.1 新目录

```text
%USERPROFILE%\.codex-to-im\
```

其中主要文件有：

- `config.v2.json`
- `config.env`（兼容性快照，不再完整表示多实例通道配置）
- `logs\bridge.log`
- `logs\ui-server.out.log`
- `runtime\status.json`
- `runtime\ui-server.json`

### 7.2 排查提示

当前版本只读取：

```text
%USERPROFILE%\.codex-to-im\
```

如果机器上仍然存在旧版本遗留的 home 目录，那只是历史残留，不再被当前版本读取。

## 8. 安装给别的主机时的建议

### 9.1 飞书

如果是同一个飞书应用，只需要在目标机重新填写：

- App ID
- App Secret
- 站点（Feishu / Lark）
- Allowed Users（如需）

不需要复制源码里的任何配置文件。

### 9.2 微信

微信建议在 **目标机重新扫码**，不要直接复制旧机器上的登录状态文件。

### 9.3 多台机器

如果你要给多台 Windows 机器部署，推荐流程是：

1. 在发布机完成 `npm run build`
2. 发布 npm 包
3. 每台目标机执行 `npm install -g codex-to-im`
4. 每台机器各自完成本地登录、配置和通道测试

## 9. 当前限制

当前版本有几个需要提前说明的点：

- 默认不是 Windows Service，而是本地 detached 进程
- 如果**未启用**开机自启动，机器重启后需要再次运行 `codex-to-im`
- 如果启用了 `codex-to-im autostart install`，开机只会自动拉起 bridge，UI 仍需按需运行 `codex-to-im`
- 当前主路径是“本地工作台 + IM 配置 + Bridge 启动”

## 9.1 Windows 上的更新方式

如果后台 UI 或 bridge 仍在运行，Windows 可能会锁住 `%APPDATA%\\npm\\node_modules\\codex-to-im`，导致：

- `npm update -g codex-to-im`
- `npm uninstall -g codex-to-im`

出现 `EBUSY` 或 `resource busy or locked`。

推荐更新步骤：

```powershell
codex-to-im stop
npm update -g codex-to-im
codex-to-im
```

## 10. 发布方注意事项

如果你要把这个包发布到 npm，当前实现要求：

1. 先在发布前执行：

```powershell
npm run build
```

2. 确保发布包中包含：

- `dist/cli.mjs`
- `dist/ui-server.mjs`
- `dist/daemon.mjs`

原因是当前包没有 `postinstall` 或 `prepare` 来在目标机自动构建。

也就是说：

- **发布到 npm 时应发布预构建产物**
- **目标机安装时不应依赖本地构建**
