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

如果你忘了当前地址，可以执行：

```bash
codex-to-im url
```

## 主流程

1. 打开工作台
2. 填写飞书配置，或触发微信扫码
3. 保存配置并测试连通性
4. 启动 bridge
5. 打开“最近桌面会话”
6. 把飞书或微信聊天绑定到目标 thread
7. 在 IM 中继续同一条 Codex 会话

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
