# Codex-to-IM Turn 架构重构开发与测试计划

## 背景

当前 IM 通信链路中，纯 IM 对话、IM 复用 Codex Desktop thread、IM 镜像 Codex Desktop thread 三类场景没有被显式建模。运行时主要依赖 `sdk_session_id`、mirror subscription、mirror suppression、SDK stream 结果和 Desktop JSONL terminal record 之间的时序关系来推断最终行为。

这导致几个长期问题：

- `sdk_session_id` 同时表示 Codex SDK thread id 和 Codex Desktop thread id，语义不清。
- 纯 IM 会话执行过一次后也会写入 `sdk_session_id`，后续可能被误判成 Desktop thread。
- IM 复用 Desktop thread 时，SDK stream 可能先于 Desktop JSONL `task_complete.last_agent_message` 收尾，导致最终附件协议没有进入正常 IM 发送路径。
- mirror suppression 同时承担防重复、回声过滤、IM Desktop turn ownership 兜底，职责过重。
- `<cti-send>` 附件解析分散在 SDK 消费、interactive runner、mirror delivery 多处。
- 流式正文、工具、计划、运行时长、上次响应距今的状态来源不统一。
- 健康检查和状态查询必须保持只读，不能作为运行态修复入口。

本计划目标是通过最大程度的结构化重构解决上述根因，而不是继续追加补丁式判断。

## 当前进度

更新时间：2026-04-27

已完成：

- 阶段 1 已完成：新增 turn 类型与 turn 分类器。
- 阶段 2 已完成主路径：新增 `TurnCoordinator` 与 Desktop terminal router，并接入 mirror runtime。
- 阶段 3 已完成主路径：新增 `ResponseAssembler` 与 `DeliveryPipeline`，并接入 interactive final 和 mirror final。
- 阶段 4 已完成主路径：新增 `StreamState`，并接入 interactive 与 mirror streaming 状态区。
- 阶段 5 已完成第一组清理：删除 bridge-manager 中旧的 mirror terminal 兜底收尾/附件补发路径。
- 阶段 5 已完成第二组清理：新增最终响应附件清理模块，`conversation-engine` 和 `response-assembler` 不再各自直接解析 `<cti-send>`。
- 阶段 5 已完成第三组清理：新增 mirror feedback controller，镜像流式状态、卡片收尾和最终投递从 `bridge-manager` 抽离。
- 阶段 5 已完成第四组清理：`mirror suppression` 不再作为 mirror delivery 的全局 blocked 条件，只作为 records 过滤器。
- `BridgeSession` 已增加 `codex_thread_id`、`desktop_thread_id`、`thread_origin`。
- 纯 IM SDK 线程与 Codex Desktop 线程已在数据模型上拆分。
- `/t` / Desktop 绑定路径会写入 `desktop_thread_id` 和 `thread_origin = 'desktop'`。
- 普通 IM SDK resume 只写入 `codex_thread_id`，不会自动成为 Desktop mirror 来源。
- mirror subscription registry 已改为只认显式 Desktop thread。
- `/model`、`/status`、`/history` 中“共享桌面线程”的判断已改为基于 `desktop_thread_id`。
- `interactive-message-runner` 的 Desktop terminal 等待只对显式 Desktop-backed session 生效，避免纯 IM 会话因为已有 SDK thread id 被误判。
- active `im_desktop_reuse` turn 会注册到 coordinator；Desktop JSONL `task_complete/task_aborted` 先尝试被 active IM turn 认领。
- 已被 active IM turn 认领的 Desktop records 会从 mirror delivery 输入中移除，降低重复回复风险。
- SDK final、Desktop terminal final、mirror final 已统一通过 response assembler 清理正文、解析附件、去重附件。
- interactive final 和 mirror final 已统一通过 delivery pipeline 执行“卡片已收尾则跳过正文、但继续补发附件”的规则。
- `lastActivityAt` 与 `lastContentResponseAt` 已拆分；工具/计划/状态说明不会再重置“上次响应距今”的正文基准。
- mirror runtime 的 health observe 不再顺带触发 IM task 收尾；IM Desktop terminal ownership 只通过 `TurnCoordinator` 认领。
- Desktop-backed IM 会话在 SDK 先结束时等待 Desktop terminal JSONL 的配置已从 4 秒 grace 改为 30 秒 terminal timeout。
- runtime terminal reconcile 不再用 terminal health 状态收尾 active IM task；health/reconcile 只做诊断和无 active task 时的 stale runtime 清理。
- Desktop terminal final 等待已从 mirror suppression 状态解耦；suppression 只作为 Desktop-backed IM turn 的 mirror 回声过滤。
- 最终响应附件清理已集中到 `src/lib/bridge/turns/final-response-artifacts.ts`，低层 `outbound-artifacts` 只保留纯解析能力。
- mirror streaming text/status/tools/tasks、stream end、mirror final delivery 已集中到 `src/lib/bridge/mirror-feedback-controller.ts`。
- `mirror-runtime` 的 delivery blocked 条件只剩 active IM task；suppression 只通过 `filterSuppressedMirrorRecords` 去掉回声 records，不再整体阻塞其他可投递 mirror turn。

已验证：

- `npm run typecheck` 通过。
- `npm run build` 通过。
- `npm test -- --test-name-pattern='bridge-manager mirror subscription recovery|mirror-runtime pending deliveries|turn-classifier|mirror-subscription-registry|session-bindings uniqueness|JsonFileStore'` 通过。当前测试脚本实际执行了 336 个测试，全部通过。
- `npm test -- --test-name-pattern='turn-coordinator|desktop-terminal-router|bridge-manager mirror terminal finalization|mirror-runtime pending deliveries|interactive-message-runner|mirror-subscription-registry'` 通过。当前测试脚本实际执行了 341 个测试，全部通过。
- `npm test -- --test-name-pattern='response-assembler|delivery-pipeline|interactive-message-runner|bridge-manager mirror terminal finalization|mirror-runtime pending deliveries|outbound-artifacts|mirror-subscription-registry|turn-coordinator|desktop-terminal-router'` 通过。当前测试脚本实际执行了 347 个测试，全部通过。
- `npm test -- --test-name-pattern='stream-state|interactive-message-runner|mirror-turns|bridge-manager status formatting|mirror-runtime pending deliveries|response-assembler|delivery-pipeline|turn-coordinator|desktop-terminal-router'` 通过。当前测试脚本实际执行了 352 个测试，全部通过。
- `npm test -- --test-name-pattern='interactive-message-runner|turn-coordinator|desktop-terminal-router|bridge-manager status formatting|mirror-runtime pending deliveries|mirror-subscription-registry|response-assembler|delivery-pipeline'` 通过。当前测试脚本实际执行了 350 个测试，全部通过。
- `git diff --check` 通过，仅有工作区 CRLF 提示。

下一步：

- 阶段 5 已完成；当前不建议继续大拆。
- 后续建议进入上线前审查、全量验证、提交发布准备。
- 后续任何清理仍必须保持 health/status 查询只读，不能把诊断命令当作运行态修复入口。

## 目标

- 明确建模三类 turn：`im_sdk`、`im_desktop_reuse`、`desktop_mirror`。
- 拆清 `codex_thread_id` 与 `desktop_thread_id`，避免用一个字段表达两种线程。
- 建立统一 `TurnCoordinator`，由它负责 active turn ownership、terminal 认领、取消、完成。
- Desktop JSONL records 先尝试被 active IM Desktop turn 认领，未认领的才进入 mirror delivery。
- 将最终响应组装集中到 `ResponseAssembler`。
- 将卡片收尾、文本发送、附件发送集中到 `DeliveryPipeline`。
- 将流式状态区集中到 `StreamState`。
- 保证 `/status` 和 `//` 健康检查只读，无任何写入副作用。
- 保证测试覆盖三类 turn 的主路径和主要竞态。

## 非目标

- 不重写 Feishu 或 Weixin adapter 的底层 API 实现。
- 不改变用户可见命令语义，除非是为了消除 bug。
- 不移除现有配置文件格式，但会增加向后兼容迁移。
- 不在开发阶段自动重启本机服务。

## 目标模型

新增统一 turn 类型：

```ts
export type BridgeTurnKind =
  | 'im_sdk'
  | 'im_desktop_reuse'
  | 'desktop_mirror';

export type BridgeTurnOrigin = 'im' | 'desktop';
export type BridgeTurnProgressSource = 'sdk_stream' | 'desktop_jsonl';
export type BridgeTurnFinalSource = 'sdk_result' | 'desktop_task_complete';

export interface ActiveBridgeTurn {
  id: string;
  sessionId: string;
  kind: BridgeTurnKind;
  origin: BridgeTurnOrigin;
  progressSource: BridgeTurnProgressSource;
  finalSource: BridgeTurnFinalSource;
  codexThreadId?: string;
  desktopThreadId?: string;
  requestMessageId?: string;
  streamKey?: string;
  startedAt: number;
}
```

三类 turn 的权威来源：

| Turn 类型 | 发起方 | 进度来源 | 最终来源 | mirror delivery |
| --- | --- | --- | --- | --- |
| `im_sdk` | IM | SDK stream | SDK result | 否 |
| `im_desktop_reuse` | IM | SDK stream + Desktop JSONL | Desktop `task_complete.last_agent_message` | 否 |
| `desktop_mirror` | Desktop | Desktop JSONL | Desktop `task_complete.last_agent_message` | 是 |

## 数据模型重构

当前 `BridgeSession.sdk_session_id` 需要保留兼容，但新增明确字段：

```ts
export interface BridgeSession {
  sdk_session_id?: string;
  codex_thread_id?: string;
  desktop_thread_id?: string;
  thread_origin?: 'bridge' | 'desktop';
}
```

字段语义：

- `codex_thread_id`：Codex SDK resume id，用于 SDK provider 继续对话。
- `desktop_thread_id`：Codex Desktop thread id，用于 Desktop JSONL mirror。
- `thread_origin = 'bridge'`：由 IM/bridge 创建的 SDK thread。
- `thread_origin = 'desktop'`：由 Codex Desktop 创建或被 `/t` 接管的 thread。
- `sdk_session_id`：旧字段，仅用于兼容读取和迁移，后续业务逻辑不再直接依赖它判断 Desktop thread。

迁移规则：

- 如果旧 `sdk_session_id` 能在 Desktop session 列表中找到，则迁移为 `desktop_thread_id` 和 `codex_thread_id`，`thread_origin = 'desktop'`。
- 如果旧 `sdk_session_id` 找不到 Desktop session，则迁移为 `codex_thread_id`，`thread_origin = 'bridge'`。
- 新建纯 IM session 不写 `desktop_thread_id`。
- `/t` 接管 Desktop thread 时写 `desktop_thread_id`，并允许 `codex_thread_id` 同步为同一个 thread id。
- mirror subscription 只能基于 `desktop_thread_id` 创建。

涉及文件：

- `src/lib/bridge/host.ts`
- `src/store.ts`
- `src/session-bindings.ts`
- `src/lib/bridge/channel-router.ts`
- `src/lib/bridge/mirror-subscription-registry.ts`

## 新增模块

### `src/lib/bridge/turns/turn-types.ts`

职责：

- 定义 turn 类型、最终响应类型、流式事件类型。
- 所有模块共享这些类型，避免隐式对象结构。

主要导出：

- `BridgeTurnKind`
- `ActiveBridgeTurn`
- `BridgeTurnClassification`
- `FinalizedBridgeResponse`
- `BridgeTurnTerminalRecord`

### `src/lib/bridge/turns/turn-classifier.ts`

职责：

- 根据 `binding`、`session`、`desktop_thread_id`、`codex_thread_id` 判断 IM 消息属于哪类 turn。
- 纯 IM 已有 `codex_thread_id` 时仍应判定为 `im_sdk`。
- 只有存在 `desktop_thread_id` 且能定位 Desktop session 时，才判定为 `im_desktop_reuse`。

主要导出：

- `classifyInteractiveTurn(binding, session, desktopLookup): BridgeTurnClassification`
- `isDesktopBackedSession(session): boolean`

### `src/lib/bridge/turns/turn-coordinator.ts`

职责：

- 注册 active IM turn。
- 管理 active turn 的 abort、final terminal、完成结果。
- 提供 Desktop terminal record 的认领入口。
- 保证同一个 terminal record 不会同时被 IM turn 和 mirror delivery 消费。
- 对 binding stale 的情况生成旧会话完成提示。

主要能力：

- `registerInteractiveTurn(turn)`
- `getActiveTurn(sessionId)`
- `claimDesktopTerminal(sessionId, record)`
- `completeFromSdkResult(turnId, result)`
- `completeFromDesktopTerminal(turnId, terminal)`
- `abortTurn(sessionId, reason)`
- `releaseTurn(turnId)`

### `src/lib/bridge/turns/desktop-terminal-router.ts`

职责：

- mirror runtime 读取 Desktop records 后，先交给该模块分流。
- 被 active `im_desktop_reuse` 认领的 records 不再进入 mirror delivery。
- 未被认领的 records 保留给 `desktop_mirror`。

主要导出：

- `routeDesktopRecords(sessionId, records, coordinator): { claimed: DesktopMirrorRecord[]; unclaimed: DesktopMirrorRecord[] }`

### `src/lib/bridge/turns/response-assembler.ts`

职责：

- 统一组装最终响应。
- 统一解析 `<cti-send>`。
- 统一 strip streaming 中不应该展示的附件协议。
- 去重附件。
- 处理 stale binding notice。

主要导出：

- `assembleSdkFinalResponse(input): FinalizedBridgeResponse`
- `assembleDesktopFinalResponse(input): FinalizedBridgeResponse`
- `mergeFinalResponses(primary, fallback): FinalizedBridgeResponse`
- `stripFinalOnlyBlocksForStreaming(text): string`

### `src/lib/bridge/turns/delivery-pipeline.ts`

职责：

- 统一处理最终发送。
- Feishu 卡片已 finalize 时，只补发附件。
- 普通文本和附件发送顺序明确。
- 失败 fallback 统一。
- 审计和 dedup key 统一。

主要导出：

- `deliverFinalResponse(context, response): Promise<SendResult>`
- `finalizeStreamingUi(context, response): Promise<boolean>`

### `src/lib/bridge/turns/stream-state.ts`

职责：

- 管理流式 UI 状态。
- 统一正文、工具、计划、状态文案、运行时长、上次响应距今。
- 分离 `lastActivityAt` 和 `lastContentResponseAt`。

关键规则：

- 正文输出更新 `lastContentResponseAt`。
- 工具、计划、状态说明只更新 `lastActivityAt`。
- 状态区刷新应随正文、工具、计划更新一起触发。
- 三分钟后如果正文无更新，`上次响应距今` 应继续变化。
- 从未有正文输出时，以 turn start 作为兜底基准。

## 现有模块调整

### `src/lib/bridge/bridge-manager.ts`

调整方向：

- 保留 bridge lifecycle、adapter loop、command 分发。
- 普通消息进入后交给 `turn-classifier` 和 `turn-coordinator`。
- mirror records 进入后先交给 `desktop-terminal-router`。
- 删除或降级 `deliverTerminalArtifactsFromMirrorRecord`。
- 减少对 mirror suppression 的直接业务判断。

### `src/lib/bridge/interactive-message-runner.ts`

调整方向：

- 收窄为 IM turn 执行器。
- 不再直接持有 Desktop terminal 补偿逻辑。
- 不再直接决定 Desktop final source。
- SDK stream 回调统一写入 `StreamState`。
- 最终结果交给 `TurnCoordinator` 和 `DeliveryPipeline`。

### `src/lib/bridge/conversation-engine.ts`

调整方向：

- 只负责向 LLM provider 发起请求并消费 SDK stream。
- 返回 SDK result，不直接承担最终业务发送决策。
- 可以保留 SDK stream 中的初步 artifact parse，但最终 parse 权威在 `ResponseAssembler`。
- `onPromptPrepared` 只作为 turn metadata 输入，不再驱动 mirror suppression ownership。

### `src/lib/bridge/mirror-runtime.ts`

调整方向：

- 继续负责 Desktop JSONL 文件监听、读取、cursor。
- 读到 records 后调用 `desktop-terminal-router`。
- unclaimed records 才进入 mirror delivery plan。
- claimed records 仍可用于健康状态观察，但不能重复投递。

### `src/lib/bridge/mirror-delivery-plan.ts`

调整方向：

- 只处理 unclaimed Desktop mirror records。
- 不再参与 IM Desktop reuse 的 terminal ownership。

### `src/lib/bridge/mirror-suppression.ts`

调整方向：

- 仅保留防重复、回声过滤。
- 不再承担 active IM turn terminal record 的主路由。
- 逐步降低 suppression 对正确性的依赖。

### `src/lib/bridge/feedback-delivery.ts`

调整方向：

- 保留底层文本和附件发送。
- 上层调用集中到 `DeliveryPipeline`。
- 不再让多个上层模块各自拼装附件发送流程。

### `src/lib/bridge/outbound-artifacts.ts`

调整方向：

- 保留纯解析函数。
- 业务调用集中到 `ResponseAssembler`。

### `src/lib/bridge/session-health-runtime.ts`

调整方向：

- 用户触发的诊断保持只读。
- 运行态写入只来自 turn lifecycle 和 mirror observe。
- 不允许健康检查触发任务收尾、卡片收尾、session 修复。

## 分阶段开发计划

### 阶段 1：类型与线程字段地基

状态：已完成（2026-04-27）

开发内容：

- 新增 `turn-types.ts`。
- 新增 `turn-classifier.ts`。
- `BridgeSession` 增加 `codex_thread_id`、`desktop_thread_id`、`thread_origin`。
- `store` 增加字段读写和迁移兼容。
- `session-bindings` 拆分 Desktop thread 绑定和 Codex SDK thread 绑定。
- `mirror-subscription-registry` 改为只认 `desktop_thread_id`。

实际落地：

- 新增 `src/lib/bridge/turns/turn-types.ts`。
- 新增 `src/lib/bridge/turns/turn-classifier.ts`。
- `src/lib/bridge/host.ts` 为 `BridgeSession` 增加线程身份字段。
- `src/store.ts` 的 `updateSdkSessionId` 只标记 bridge-side Codex resume thread，`findSessionBySdkSessionId` 兼容旧字段和新字段。
- `src/session-bindings.ts` 在 Desktop 绑定时显式写入 `desktop_thread_id`。
- `src/lib/bridge/mirror-subscription-registry.ts` 只基于显式 Desktop thread 生成 mirror subscription。
- `src/lib/bridge/mirror-runtime.ts` 使用 `desktop_thread_id` 作为镜像线程来源。
- `src/lib/bridge/command-dispatch.ts` 的 `/model`、`/status`、`/history` 使用 `desktop_thread_id` 判断是否共享桌面线程。
- `src/lib/bridge/interactive-message-runner.ts` 只在 Desktop-backed session 上等待 Desktop terminal finalization。
- 补充 `src/__tests__/turn-classifier.test.ts`，并更新 store、session binding、mirror subscription、mirror runtime、bridge manager 相关测试。

验收标准：

- 纯 IM 已有 `codex_thread_id` 时不会创建 mirror subscription。
- `/t` 接管 Desktop thread 后会写入 `desktop_thread_id`。
- 旧数据能兼容读取。

阶段备注：

- 旧字段 `sdk_session_id` 暂时保留为兼容字段，后续业务判断应优先使用 `codex_thread_id` / `desktop_thread_id`。
- 历史上没有 `thread_origin` 的旧纯 IM 数据不会被自动当作 Desktop thread。
- 后续阶段仍需要把 terminal ownership 从 mirror suppression/grace wait 中彻底抽出。

### 阶段 2：TurnCoordinator 与 terminal ownership

状态：主路径已完成（2026-04-27）

开发内容：

- 新增 `turn-coordinator.ts`。
- 新增 `desktop-terminal-router.ts`。
- `interactive-message-runner` 注册 active turn。
- `mirror-runtime` 读到 records 后先走 terminal router。
- `task_complete` 被 active `im_desktop_reuse` 认领后，不再进入 mirror delivery。

实际落地：

- 新增 `src/lib/bridge/turns/turn-coordinator.ts`。
- 新增 `src/lib/bridge/turns/desktop-terminal-router.ts`。
- `interactive-message-runner` 注册并释放 active bridge turn。
- `bridge-manager` 创建全局 `TURN_COORDINATOR`，并将 Desktop terminal finalization 连接到 `INTERACTIVE_RUNTIME.finalizeTerminalActiveTask`。
- `mirror-runtime` 读取 Desktop records 后先调用 `routeDesktopRecords`，claimed records 不再进入 health observe / mirror delivery。
- 补充 `src/__tests__/turn-coordinator.test.ts` 和 `src/__tests__/desktop-terminal-router.test.ts`。

验收标准：

- SDK 先结束，Desktop terminal 后到，最终使用 Desktop final。
- Desktop terminal 先到，SDK stream 被正确收尾。
- Desktop 自己发起的 turn 不会被 IM active turn 误认领。
- 不出现重复回复。

阶段备注：

- 旧的 `finalizeInteractiveTaskFromMirrorRecords` 已在阶段 5 删除，不再作为 mirror observe 的隐式副作用。
- 旧的 `desktopTerminalFinalizationGraceMs` 已在阶段 5 移除，替换为 Desktop terminal final timeout。
- 当前阶段已经把 terminal ownership 的主入口前移到 mirror runtime record routing，但最终文本/附件组装仍未集中，下一阶段处理。

### 阶段 3：ResponseAssembler 与 DeliveryPipeline

状态：主路径已完成（2026-04-27）

开发内容：

- 新增 `response-assembler.ts`。
- 新增 `delivery-pipeline.ts`。
- 将 SDK final、Desktop terminal、mirror final 都改为统一组装。
- 附件解析、附件去重、stale notice 集中处理。
- 卡片 finalize 和附件补发集中处理。

实际落地：

- 新增 `src/lib/bridge/turns/response-assembler.ts`。
- 新增 `src/lib/bridge/turns/delivery-pipeline.ts`。
- `interactive-message-runner` 使用 assembler 处理 SDK final、Desktop terminal final、stale notice 和 error response。
- `interactive-message-runner` 使用 pipeline 统一处理最终发送和流式 UI finalize。
- `bridge-manager` 的 mirror final 使用 assembler 清理 Desktop final text 和提取附件。
- `bridge-manager` 的 mirror final 使用 pipeline 发送普通镜像文本、卡片 finalize 后附件补发。
- 补充 `src/__tests__/response-assembler.test.ts` 和 `src/__tests__/delivery-pipeline.test.ts`。

验收标准：

- `<cti-send>` 在所有路径只解析一次。
- Feishu 卡片正文不显示附件协议。
- 卡片已收尾时，附件仍能发送。
- Weixin 不支持直发附件时能返回本地路径提示。

阶段备注：

- `conversation-engine` 当前仍会在保存 assistant message 时解析一次 `<cti-send>`，用于持久化清理和返回附件；assembler 对已清理文本再次处理是幂等的。后续若要做到严格“物理只解析一次”，需要把 conversation-engine 的持久化解析也改为调用 assembler 或返回 raw final blocks。
- mirror 文本仍需先用 clean final text 进入 `formatMirrorMessage`，因此 assembler 在 mirror path 中先处理 raw Desktop final，再将渲染后的镜像正文交给 delivery pipeline。
- 旧的 `deliverTerminalArtifactsFromMirrorRecord` 已在阶段 5 删除，terminal 附件不再通过 mirror observe 旁路补发。

### 阶段 4：StreamState 收敛状态区

状态：主路径已完成（2026-04-27）

开发内容：

- 新增 `stream-state.ts`。
- `interactive-message-runner` 和 mirror streaming 都改用统一状态。
- 分离 `lastActivityAt` 和 `lastContentResponseAt`。
- 工具、计划、正文、状态说明更新时都触发状态区刷新。

实际落地：

- 新增 `src/lib/bridge/turns/stream-state.ts`，集中处理运行时长、`上次响应距今`、正文响应基准和 activity 基准。
- `src/lib/bridge/interactive-message-runner.ts` 使用 `StreamState` 记录正文响应、工具、计划、权限等待和状态说明。
- `src/lib/bridge/mirror-turns.ts` 为 mirror pending turn 增加 `lastContentResponseAt`，并保留旧 `lastResponseAt` 兼容读取。
- `src/lib/bridge/bridge-manager.ts` 的 mirror streaming status 刷新改用 `StreamState` 格式化逻辑，旧数据缺少正文响应时间时回退到 turn start。
- 补充 `src/__tests__/stream-state.test.ts`，并更新 interactive runner、mirror turns、bridge manager 相关测试。

验收标准：

- 长任务三分钟后显示并持续更新 `上次响应距今`。
- 工具和计划更新不会重置正文响应时间。
- 正文更新会重置正文响应时间。
- `已运行` 和 `上次响应距今` 至少一个会按预期变化。

阶段备注：

- `lastActivityAt` 仍用于健康状态和“是否有运行进展”的判断；用户可见的 `上次响应距今` 只看正文成功响应时间。
- 从未产生正文时，`上次响应距今` 以 turn start 为兜底基准，避免长任务没有任何正文时状态区完全静止。
- 旧 mirror pending turn 的 `lastResponseAt` 暂时保留为兼容字段，后续阶段 5 再评估是否清理。

### 阶段 5：删除旧补丁和降低 suppression 依赖

状态：已完成（2026-04-27）

开发内容：

- 删除 `desktopTerminalFinalizationGraceMs` 作为主路径。
- 删除或降级 `deliverTerminalArtifactsFromMirrorRecord`。
- 删除散落的最终附件解析。
- 收窄 mirror suppression。
- 清理 bridge-manager 中的 turn orchestration。

已完成：

- 删除 `src/lib/bridge/bridge-manager.ts` 中的 `finalizeInteractiveTaskFromMirrorRecords`。
- 删除 `src/lib/bridge/bridge-manager.ts` 中的 `deliverTerminalArtifactsFromMirrorRecord`。
- mirror runtime 的 `observeSessionHealthRecords` 只做 health observe，不再触发 IM active task finalize 或 terminal artifact 补发。
- `_testOnly` 不再暴露旧的 mirror terminal finalization 入口。
- `desktopTerminalFinalizationGraceMs` 改为 `desktopTerminalFinalizationTimeoutMs`，并把默认等待从 4 秒提升到 30 秒，明确表达“等待 Desktop terminal 作为 canonical final source”。
- 新增 `src/lib/bridge/turns/final-response-artifacts.ts`，统一最终响应正文清理和附件去重。
- `src/lib/bridge/turns/response-assembler.ts` 和 `src/lib/bridge/conversation-engine.ts` 都改为复用 `final-response-artifacts`。
- 新增 `src/lib/bridge/mirror-feedback-controller.ts`，集中 mirror streaming UI 更新、状态刷新、卡片收尾和最终消息投递。
- `src/lib/bridge/bridge-manager.ts` 只保留 mirror feedback controller 的初始化和对 `mirror-runtime` 的回调包装。
- `src/lib/bridge/mirror-runtime.ts` 不再依赖 `isMirrorSuppressed` 判断全局 blocked；suppression 只影响 `filterSuppressedMirrorRecords` 的 records 过滤结果。
- `src/lib/bridge/interactive-runtime.ts` 不再根据 terminal health 状态 finalize active IM task，避免 health/reconcile 成为隐式收尾路径。
- `src/lib/bridge/interactive-message-runner.ts` 的 Desktop terminal final 等待不再依赖 `mirrorSuppressionId`，并且只在 Desktop-backed IM turn 创建 suppression。
- 补充 `src/__tests__/mirror-runtime.test.ts` 用例，覆盖 suppression filtering 后剩余 mirror records 仍会正常投递。
- 已评估 `src/lib/bridge/bridge-manager.ts` 中剩余 mirror reconcile wiring：当前主要是依赖装配、配置读取、状态同步和测试出口，继续下沉收益低，不建议为了拆分而拆分。

验收标准：

- 代码路径更短，turn ownership 单一。
- mirror suppression 失效也不会导致 IM Desktop final 丢失。
- 全量测试通过。

## 测试计划

### 单元测试

新增测试文件：

- `src/__tests__/turn-classifier.test.ts`
- `src/__tests__/turn-coordinator.test.ts`
- `src/__tests__/desktop-terminal-router.test.ts`
- `src/__tests__/response-assembler.test.ts`
- `src/__tests__/delivery-pipeline.test.ts`
- `src/__tests__/stream-state.test.ts`

### 关键测试用例

`turn-classifier`：

- 无 `desktop_thread_id`，有 `codex_thread_id`，判定为 `im_sdk`。
- 有真实 `desktop_thread_id`，判定为 `im_desktop_reuse`。
- `desktop_thread_id` 找不到 Desktop session 时降级或标记 stale。

`turn-coordinator`：

- 注册 active IM turn。
- SDK result 先到，等待 Desktop terminal。
- Desktop terminal 先到，完成 active turn。
- `/stop` abort 后 terminal 到达不重复发送。
- binding 已切换时生成 stale notice。

`desktop-terminal-router`：

- active IM Desktop turn 能认领同一 turn 的 `task_complete`。
- 未匹配的 Desktop records 保留给 mirror。
- 多个 active/queued turn 不串线。

`response-assembler`：

- `<cti-send>` 被移除并解析为附件。
- 多附件去重。
- 无正文但有附件时仍能发送。
- stale notice 时丢弃旧附件。

`delivery-pipeline`：

- 卡片 finalize 成功后只发送附件。
- 卡片 finalize 失败后发送文本和附件。
- 附件发送失败时给出可见错误。
- Weixin 不支持直发时给出本地路径提示。

`stream-state`：

- 正文更新刷新 `lastContentResponseAt`。
- 工具更新只刷新 `lastActivityAt`。
- 计划更新触发状态区刷新。
- 超过三分钟后 `上次响应距今` 持续变化。

### 回归测试

需要保留并改造现有测试：

- `interactive-message-runner.test.ts`
- `bridge-manager.test.ts`
- `mirror-runtime.test.ts`
- `mirror-delivery-plan.test.ts`
- `mirror-subscription-registry.test.ts`
- `session-health-runtime.test.ts`
- `command-dispatch.test.ts`
- `feishu-adapter.test.ts`

### 集成验证

不启动生产服务的自动验证：

- `npm run typecheck`
- `npm test`
- `npm run build`

手动验证场景：

- 纯 IM 连续两轮对话，无 4 秒等待，无 mirror subscription。
- `/t 1` 接管 Desktop thread 后发送 IM 消息，最终以 Desktop terminal 为准。
- Desktop 中直接执行任务，IM mirror 正常显示。
- 飞书长任务卡片状态区持续刷新。
- 生成图片后通过 `<cti-send>` 发送附件。
- `/status` 和 `//` 不创建 binding，不修改 session。

## 风险与应对

风险：旧 `sdk_session_id` 数据无法准确判断来源。

应对：迁移时优先查 Desktop session index，找不到则标为 `bridge`，并保留旧字段以便回退。

风险：Desktop JSONL `turn_id` 缺失或延迟。

应对：优先用 `turn_id` 匹配，缺失时用 prompt signature 和时间窗口兜底。

风险：重构期间出现重复回复。

应对：`TurnCoordinator` 必须保证 terminal record 一旦 claimed，就不能进入 mirror delivery。

风险：Feishu 卡片 finalize 和附件发送顺序变化。

应对：`DeliveryPipeline` 明确卡片 finalize 与附件发送幂等规则，并补测试。

风险：一次性改动过大。

应对：按阶段落地，每阶段都保持可测试、可构建、可回退。

## 推荐提交边界

建议拆成 5 个提交：

1. `Add explicit turn and thread identity model`
2. `Route desktop terminal records through turn coordinator`
3. `Unify final response assembly and attachment delivery`
4. `Centralize streaming state updates`
5. `Remove legacy terminal artifact fallback paths`

## 完成标准

- 三类 turn 的来源、进度、最终回复来源在代码中显式可见。
- 纯 IM 不再被误判为 Desktop mirror。
- IM 复用 Desktop thread 不再依赖补发附件。
- Desktop mirror 不再和 active IM turn 抢同一条 terminal record。
- `<cti-send>` 只在一个统一模块被业务解析。
- `/status` 和 `//` 无副作用。
- 全量测试、类型检查、构建通过。
