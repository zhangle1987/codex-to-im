# AGENTS.md - Codex-to-IM Project Guidelines

本仓库是 `codex-to-im`，一个本地 npm 包，用来把 Codex 接入飞书、微信等 IM 通道。维护目标不是只让单个接口跑通，而是保证 CLI、Web UI、bridge 守护进程、Codex SDK、Codex Desktop thread、IM 通道和本地持久化状态之间长期一致。

## 工作原则

- 默认先理解真实运行链路，再改代码。不要只看 README，也不要只看最近一次提交。
- 不要回退用户或其他线程留下的未提交修改。遇到冲突先说明并询问。
- 不要随意启动、停止或重启本机 bridge/UI。当前机器可能正在通过 IM 使用本项目，重启必须由用户明确要求。
- 如果确实需要重启正在服务中的 bridge，必须先完成全部代码修改、测试和构建，再使用延迟启动方案，最后停止旧进程，避免把当前 Codex 执行中断在半路。
- 健康检查、线程状态查询、日志读取应无副作用，不应修改 session、binding、runtime 或 mirror 状态。
- 面向生产改动时优先保证收尾路径可靠：任务完成、失败、`/stop`、bridge 重启、IM 绑定切换、附件回传都不能让卡片或会话卡死。

## 关键运行链路

- CLI 入口主要在 `src/cli.ts`，构建后输出到 `dist/cli.mjs`，全局命令是 `codex-to-im`。
- bridge 守护进程入口在 `src/main.ts`，负责初始化配置、store、LLM provider、adapter runtime，并启动 `bridge-manager`。
- Web 工作台入口在 `src/ui-server.ts`，负责配置、状态、启动停止、安装 skill、微信登录等本地管理能力。
- 服务管理、启动停止、开机自启动、卸载相关逻辑集中在 `src/service-manager.ts` 和 `scripts/supervisor-*.sh|ps1`。
- bridge 编排核心在 `src/lib/bridge/bridge-manager.ts`，不要把通道细节、Codex SDK 细节或 store 细节继续塞回这个文件，优先保持职责拆分。
- IM 任务执行链路主要经过 `src/lib/bridge/interactive-message-runner.ts`、`src/lib/bridge/interactive-runtime.ts`、`src/lib/bridge/delivery-pipeline.ts`。
- Codex SDK provider 在 `src/codex-provider.ts`，负责把 SDK 事件转换为项目内部 SSE/text/tool/task/status/usage 事件。
- Codex Desktop 线程发现和 mirror 解析在 `src/desktop-sessions.ts` 以及 `src/lib/bridge/mirror-*.ts`。
- 飞书通道在 `src/lib/bridge/adapters/feishu-adapter.ts`，微信通道在 `src/adapters/weixin-adapter.ts` 及相关 `weixin-*` 模块。

## 三类会话要分清

- 纯 IM SDK 会话：IM 消息直接通过 `@openai/codex-sdk` 执行，收尾由 SDK stream 和 delivery pipeline 负责。
- IM 复用桌面线程：IM 绑定到 Codex Desktop thread，可能需要结合 SDK stream 和桌面 JSONL terminal records 才能拿到完整最终回复和附件。
- mirror 桌面会话：Codex Desktop 里发生的对话被 mirror 到 IM，不应当当成 IM 主动发起的任务重复执行。

改动 Codex 事件、final response、附件、卡片收尾、状态心跳、去重和 suppress 逻辑时，必须分别检查这三类会话。不要用一个局部补丁让三类消息类型更混乱。

## 配置和持久化

- 用户数据默认在 `~/.codex-to-im`，包括配置、日志、运行态、会话、绑定、消息、权限、offset、audit 等。
- 新配置以 `config.v2.json` 为主，旧的 `config.env` 只作为迁移/兼容来源。
- store 的核心实现是 `src/store.ts`，运行态健康状态在 `src/lib/bridge/session-health-runtime.ts` 等模块。
- 影响运行行为的配置包括 runtime、默认 model、reasoning effort、sandbox mode、历史消息条数、流式状态阈值、Feishu/Weixin 通道实例、markdown 反馈、workspace root、Codex skip git repo check 等。
- 修改配置映射时同步检查 `src/config.ts`、UI 表单、README/docs、`configToSettings` 测试。

## IM 通道约束

- 飞书支持结构化流式卡片，正文、任务、工具、状态区分区更新。卡片最终必须通过 `onStreamEnd` 收尾。
- 飞书 reaction 只用于明确终态提示：完成用 `DONE`，失败用 `ERROR`，目标是卡片自身 `messageId`。不要在执行中给用户原消息反复添加 reaction。`interrupted` 不按失败处理。
- 微信通道没有飞书同等的流式卡片能力，长任务状态主要依赖用户主动发送 `//` 查看健康状态，不要把飞书专属体验硬套到微信。
- 附件回传协议由 `SKILL.md` 和 outbound artifact 解析负责。改动最终回复去重、mirror suppress 或 SDK 收尾时，必须确认附件仍会进入 `deliverResponse(...attachments)`。

## Codex SDK / CLI 更新检查

当 `@openai/codex-sdk` 或 Codex CLI 更新时，优先检查这些内容：

- `src/codex-provider.ts` 是否兼容新的 SDK event kind、item type、usage 字段、reasoning 字段、tool 调用字段和 terminal event。
- `src/desktop-sessions.ts` 是否能解析新的 Desktop JSONL 记录，尤其是 `task_complete`、`turn.completed`、reasoning、plan/todo、tool call、file change、web search、附件协议。
- 是否仍能区分 SDK thread id 和 Desktop thread id，避免 `/t` 绑定、mirror subscription 或 resume 走错线程。
- Windows 上 SDK/CLI 清理子进程时的 stdout/stderr 噪声是否会被误判为模型输出或错误。
- `reasoning_output_tokens` 等 usage 字段是否继续被保留并写入状态/日志/测试。
- 如果更新 SDK，必须同步 `package.json` 和 `package-lock.json`，并运行针对 Codex provider、desktop sessions、interactive runner、mirror runtime 的测试。

## 测试和构建

- 常规验证：`npm run typecheck`、`npm test`、`npm run build`。
- 发布前验证：`npm publish` 会触发 `prepublishOnly`，其中包含 typecheck 和 build；但提交前仍建议本地先跑相关专项测试。
- 飞书卡片/流式状态改动优先跑 `npx tsx --test src/__tests__/feishu-adapter.test.ts`、`interactive-message-runner`、`mirror-feedback-controller`、`delivery-pipeline` 相关测试。
- Codex SDK 更新优先跑 `codex-provider`、`desktop-sessions`、`response-assembler`、`outbound-artifacts`、`turn-classifier` 相关测试。
- 不要为了测试随便启动真实 bridge 或连接真实 IM，除非用户明确要求。

## 发布和本机安装

- npm 发布必须 bump `package.json` 和 `package-lock.json` 版本号。
- 发布流程通常是：测试通过、`npm run build`、提交、推送、`npm publish`、`npm view codex-to-im version` 确认。
- `codex-to-im uninstall` 只能尽力停止本地服务、解除开机自启动，并异步尝试全局 npm 卸载。彻底删除 `~/.codex-to-im`、skill 目录或残留全局包时，应提示用户手动处理，不要默认做破坏性清理。
- Windows 开机自启动需要管理员权限。不要假设当前终端有管理员权限。

## GitHub Issue 回复

回复用户 issue 时，结尾必须包含自助排查提示，指导用户用自己的 AI coding assistant 读取日志、配置并运行 doctor 脚本。

示例：

> **自助排查提示：** 你可以直接在 Codex 中发送以下提示，让 AI 帮你诊断问题：
>
> ```text
> 请帮我排查 Codex-to-IM bridge 服务的问题。
> 1. 读取 ~/.codex-to-im/logs/bridge.log 最近 80 行日志
> 2. 读取 ~/.codex-to-im/config.v2.json，检查通道配置、runtime、默认模型和流式状态配置
> 3. 如果当前仓库存在 scripts/doctor.ps1，就运行 powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1 并分析输出
> 4. 根据日志和配置判断是配置问题、通道权限问题、Codex SDK 问题、Desktop thread 绑定问题，还是 bridge 运行态问题
> 5. 给出具体修复建议，不要直接删除用户数据
> ```

## 新线程维护提示词模板

当需要开启新线程专门跟进 Codex CLI / SDK 更新或生产 bug 修复时，可以使用下面的提示词：

```text
你现在负责维护 D:\codex\Claude-to-IM-skill 这个项目。

目标：
1. 跟进最新 Codex CLI / @openai/codex-sdk 变化，确认是否需要同步适配
2. 修复当前生产 bug，尤其是 IM 回复、Desktop thread 复用、mirror、飞书流式卡片、附件回传、状态健康检查相关问题
3. 保持工程可发布，不破坏现有飞书/微信通道和本地服务管理能力

工作要求：
1. 先阅读 AGENTS.md、README.md、docs/install-windows.md、src/lib/bridge/ARCHITECTURE.md，理解真实运行链路
2. 不要优先看最近提交，也不要假设上一步修改就是根因
3. 不要回退任何未提交修改
4. 不要随意启动、停止或重启 bridge/UI；如需重启，先给出安全方案并等待确认
5. 分清三类会话：纯 IM SDK 会话、IM 复用桌面线程、mirror 桌面会话
6. 修 Codex SDK 兼容时，重点检查 src/codex-provider.ts、src/desktop-sessions.ts、src/lib/bridge/mirror-*.ts、src/lib/bridge/interactive-message-runner.ts、src/lib/bridge/delivery-pipeline.ts
7. 修飞书展示时，重点检查 src/lib/bridge/adapters/feishu-adapter.ts；reaction 只在终态给卡片自身 messageId 发 DONE/ERROR，不要执行中反复发 reaction
8. 修附件/最终回复时，必须确认最终文本和 attachments 都进入统一 delivery pipeline，不要被 mirror suppress 或去重误挡
9. 每次修改后至少运行相关专项测试、npm run typecheck；发布前运行 npm test 和 npm run build
10. 输出结论用中文，引用明确文件路径

第一步请先审查当前代码和 npm 上最新 @openai/codex-sdk / Codex CLI 变化，给出兼容性风险清单和建议修改范围。先不要改代码，等确认方案后再实现。
```
