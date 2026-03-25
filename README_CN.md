# Codex-to-IM

`codex-to-im` 是一个本地桥接应用，用来把 Codex 桌面会话接到飞书、微信等 IM 渠道。

这个项目现在不再以 Skill 为中心。主路径是：

1. 安装 `codex-to-im`
2. 打开本地 Web 工作台
3. 配置 IM 渠道
4. 在后台启动 bridge
5. 把真实的桌面 Codex thread 绑定到飞书或微信聊天

仓库里仍然保留了 `SKILL.md`，但它只是一个可选的 Codex 集成入口，不再是产品本体。

## 项目来源

当前这套代码是在两个早期仓库的基础上整理和改造出来的：

- `Claude-to-IM`
- `Claude-to-IM-skill`

现在的 `codex-to-im` 是在这两个工程基础上继续演进的单包版本，重点调整成了本地应用、共享 thread 和可选 Codex 集成的形态。

Windows 主机安装说明见：[docs/install-windows.md](D:/codex/Claude-to-IM-skill/docs/install-windows.md)

## 现在包含什么

- 本地后台 bridge 服务
- 本地 Web 工作台，用于配置、测试、日志和绑定管理
- 飞书凭据配置与连通性测试
- 微信扫码登录
- 从 `~/.codex/sessions` 发现桌面会话
- 在网页中查看和切换 IM 绑定
- 可选的 Codex 集成，仅用于打开 `codex-to-im` 或进入飞书共享入口

## 安装

### 依赖

- Node.js 20+
- 如果使用 `codex` 或 `auto` 运行时：需要在同一系统用户下完成 Codex 认证

`codex-to-im` 当前已经随包带上运行所需的 `@openai/codex-sdk` / Codex CLI 平台依赖，正常使用 bridge 时不要求你额外再全局安装一份 Codex CLI。

但你仍然需要让 Codex 在当前用户下可用。推荐满足以下任一条件：

- 已安装并登录过 Codex Desktop App
- 已经有可用的 Codex CLI 登录态
- 已配置 `CTI_CODEX_API_KEY`、`CODEX_API_KEY` 或 `OPENAI_API_KEY`

如果你机器上还没有任何 Codex 登录态，最直接的做法仍然是临时安装一次全局 Codex CLI 并登录：

```bash
npm install -g @openai/codex
codex auth login
```

### 全局安装

```bash
npm install -g codex-to-im
```

### 本地开发

```bash
npm install
npm run build
```

## 启动

启动本地应用：

```bash
codex-to-im
```

它会拉起本地工作台并在浏览器中打开。

默认地址：

```text
http://127.0.0.1:4781
```

如果默认端口已被占用，应用会自动选择一个可用端口，并在启动时把实际地址打印到命令行。

默认情况下，Web 工作台只允许本机访问。

如果你需要在手机或同一局域网里的其他设备上打开配置页，可以在“配置”页里勾选“允许局域网访问 Web 控制台”。开启后：

- 工作台会显示当前可用的局域网地址
- 工作台会生成并展示一个访问 token
- 局域网设备访问时会先进入登录页，输入 token 后才能查看和修改配置
- 也可以直接复制页面里的局域网登录链接，链接里会附带 `?token=...`

如果你忘了当前地址，可以执行：

```bash
codex-to-im url
```

查看当前本地服务状态：

```bash
codex-to-im status
```

停止后台 UI 和 bridge：

```bash
codex-to-im stop
```

## 主流程

1. 打开工作台
2. 填写飞书配置，或触发微信扫码
3. 保存配置并测试连通性
4. 启动 bridge
5. 打开“最近桌面会话”
6. 把飞书或微信聊天绑定到目标 thread
7. 在 IM 中继续同一条 Codex 会话

如果开启了局域网访问，推荐在本机工作台里复制局域网登录链接，再发给你的手机或局域网里的其他设备。

常用命令补充：

- `/` / `/status` 查看当前会话
- `/h` / `/help` 查看帮助
- `/t` / `/threads` 查看最近桌面会话，`/t 1` / `/thread 1` 接管第 1 条
- `/n proj1` / `/new proj1` 在默认工作空间下新建项目会话
- `/m` / `/mode` 查看或切换模式，可选 `code` / `plan` / `ask`
- `/r` / `/reasoning` 查看或切换思考级别，可选 `0|1|2|3|4|5`
- `/his` / `/history` 查看整理后的历史摘要，`/his raw` / `/history raw` 查看原始记录
- `/t 0` / `/thread 0` 进入临时草稿线程，不污染正式工作会话
- `1 / 2 / 3` 或 `/perm ...` 处理权限
- N 可在 Web 工作台的“基础配置”里调整
- Web 工作台的“命令说明”页会同时列出短命令和兼容原命令

如果你启用了飞书流式响应卡片，需要先在飞书应用侧开通并发布相关权限，至少包括：

- `cardkit:card:write`
- `cardkit:card:read`
- `im:message:update`

如果缺少这些权限，Bridge 日志里通常会看到 `99991672` 和 `cardkit:card:write`，系统会自动退回到最终结果消息。

另外要注意：当前 `codex` runtime 下，`Codex CLI / SDK` 实际返回的正文文本事件通常只在 `item.completed` 时出现，不是 token 级逐字输出。所以“飞书流式响应卡片”在当前版本里更准确的含义是：

- 可以先显示 `Thinking / Tool Progress`
- 正文通常会在回答完成时一次性落到卡片里

也就是说，飞书侧当前不保证像聊天模型网页那样逐字冒字。

如果新建会话时报 `Not inside a trusted directory`，可以：

- 把默认工作目录改成一个你已经信任的 Git 仓库
- 或在基础配置里打开“允许在未信任 Git 目录运行 Codex”，然后重启 Bridge

当前配置页新增了几项和 Codex 运行行为直接相关的配置：

- `默认工作空间`
  - 给 `/new proj1` 这类相对项目名提供父目录
  - 留空时默认回退到 `~/cx2im`，并按当前系统展开为实际路径
- `Codex 文件系统权限`
  - 可选 `read-only`、`workspace-write`、`danger-full-access`
  - 默认 `workspace-write`
- `Codex 思考级别`
  - 全局默认值，可在 IM 中用 `/reasoning` 对当前会话覆盖
  - 官方仅有 5 个级别：`minimal`、`low`、`medium`、`high`、`xhigh`
  - IM 中也支持数字别名：`0=minimal`、`1=low`、`2=medium`、`3=high`、`4/5=xhigh`

如果你是在自己的本地开发机上长期用 `codex-to-im` 做实际编码，当前更激进的推荐配置是：

- `Codex 文件系统权限` 设为 `danger-full-access`
- `Codex 思考级别` 设为 `xhigh`

这样更接近完整 `code` 模式下的开发体验。它适合你自己的受控项目目录，不适合直接照搬到陌生仓库或高风险环境。

通道页还支持“命令反馈使用 Markdown”开关：
- 飞书默认开启
- 微信默认关闭
- 只影响 `/h`、`/status`、`/threads` 这类 bridge 自己生成的反馈
- 不影响 Codex 原始回复内容

## 更新

Windows 上如果后台 UI 或 bridge 仍在运行，`npm update -g codex-to-im` 可能会因为安装目录被占用而报 `EBUSY`。

推荐更新流程：

```bash
codex-to-im stop
npm update -g codex-to-im
codex-to-im
```

## 可选 Codex 集成

仓库里仍然保留了一个很薄的可选集成，定义在 `SKILL.md`。

它不是必需的。

如果你把它装到 `~/.codex/skills/codex-to-im`，它只保留两个动作：

- 打开 `codex-to-im`
- 打开“共享当前会话到飞书”的入口

你可以在 Web UI 中安装这层可选集成，也可以手动执行：

```bash
bash scripts/install-codex.sh --link
```

## 仓库结构

- `src/ui-server.ts` — 本地工作台 UI 和 HTTP API
- `src/service-manager.ts` — bridge 与 UI 的生命周期管理
- `src/desktop-sessions.ts` — 从 Codex 会话文件发现桌面 thread
- `src/session-bindings.ts` — 绑定摘要与网页侧切换
- `src/lib/bridge/` — bridge 运行时与 IM 路由
- `SKILL.md` — 可选 Codex 集成，不是主产品
- `docs/` — PRD 与共享 thread 技术设计

## 开发

```bash
npm run typecheck
npm run build
```

## 当前方向

- 先做独立本地应用
- 先做 Web 工作台
- 先做共享 Codex thread
- Codex 集成是可选增强，不是主安装路径

[English](README.md)
