# Trace Schema：OpenCode 实现

本文描述当前 opencode-observer 在 OpenCode hooks/events 与受支持的 AI SDK 生命周期回调下，实际通过 OTLP HTTP/JSON 导出的 trace 结构、span attributes、数据来源和测量限制。它是读取现有导出数据、实现适配和编写测试的依据。

[期望规范](trace.md) 定义目标拓扑与字段语义；本文沿用相同的 span 章节顺序，逐项说明如何落地。尚未导出的目标字段集中列在[第 14 节](#14-与期望规范的差距)，不列为已实现属性。行为识别机制见[适配层设计](../adapter.md)，层间接口见 [Observer 契约](../../src/contract/observer.ts)。

默认 span 名称前缀为 `opencode.`；通过 `tracePrefix` / `OPENCODE_TRACE_PREFIX` 替换此前缀。本文保留 `run`、`interaction`、`llm` 等 OpenCode 专用 span 名称，通过 `gen_ai.operation.name` 表达标准操作语义。这是 GenAI 规范允许的框架专用命名约定；名称前缀只影响 span 名称。

插件生成的内建 `opencode.*` span 属性键通过独立的 `attributePrefix` / `OPENCODE_ATTRIBUTE_PREFIX` 配置前缀，默认 `opencode.`，不继承名称前缀。两项均原样拼接，不自动补 `.`，空字符串表示移除对应前缀。本文属性表使用默认键名；例如属性前缀为 `app.` 时，内建 `opencode.llm.retry_count` 导出为 `app.llm.retry_count`，不同时导出旧键。

属性值、operation 值、标准属性和 `ai.agent.skill.name` 保持不变；用户显式配置的 `spanAttributes` 与 `resourceAttributes` 保留原键名。`spanAttributes` 中受保护的内建字段按默认前缀和配置前缀同时过滤，避免伪造观测结果或绕过正文采集；其他自定义键（例如 `opencode.custom.tag`）原样保留。

## 1. Schema 约定

### 1.1 规范基线

采用[期望规范 §1.1](trace.md#11-规范基线)固定的 OTel / GenAI 基线及 `opencode.*` 扩展，不导出 OpenInference 属性。span envelope、resource、instrumentation scope 与业务 attributes 的边界同该规范。本文的“必有”描述当前插件写入行为，不代表所有传输、存储环节都能保留该字段。

### 1.2 类型、内容采集与缺省值

- `必有`：span 创建时或正常结束时一定写入；`条件`：仅在指定数据或关联存在时写入；`初始值`：创建时写入，结束前可能更新。
- `int` 表示整数计数，`double` 表示浮点值；两者在 JavaScript 中均为 `number`。`string[]` 是原生 OTel 字符串数组，不序列化为 JSON 字符串。
- `string(JSON)` 表示按期望规范的结构序列化一次的 JSON 字符串，是当前 JS SDK 的导出形式。不能把 JSON 字符串再次编码，也不能据此认为 OTLP 不支持嵌套对象。
- 缺失数据省略，不用 `0`、空字符串、空数组或 `unknown` 冒充实际值。`user.id` 是显式例外：身份查询最终失败且没有其他身份来源时，使用 `unknown` 标记身份未知。明确观察到的零用量、空输出，以及下文约定的重试初始状态不属于缺失值。
- 成功结束保持 span status 为 `UNSET`，失败设置 `ERROR`。本文不主动写入 `OK`；`UNSET` 是 status code，不代表 span 尚未结束，结束由 `end()` / end time 表达。[OTel 错误记录规范][otel-errors]

遥测和正文采集默认关闭，配置方式见 [README](../../README.md#配置)。下文所有输入、输出、系统指令及工具参数/结果字段均以开启正文采集且取得相应数据为前提；关闭正文采集时省略，不能用空值表示未采集。

## 2. Resource 与 instrumentation scope

### 2.1 Resource attributes

| 字段                          | 类型   | 默认值或来源                            | 说明                                                                |
| ----------------------------- | ------ | --------------------------------------- | ------------------------------------------------------------------- |
| `service.name`                | string | `opencode`                              | 遥测生产者服务名。                                                  |
| `service.version`             | string | 当前 OpenCode 版本；无法识别时省略      | 插件包版本记录在 instrumentation scope。                            |
| `os.type`                     | string | OS 检测结果，归一化为 OTel 值           | 例如 `windows`、`linux`、`darwin`；不能直接写入 Node 的 `win32`。   |
| `host.arch`                   | string | 主机 CPU 架构检测结果，归一化为 OTel 值 | 例如 `amd64`、`x86`、`arm32`、`arm64`；不能直接写入 Node 的 `x64`。 |
| `<custom-resource-attribute>` | string | `OPENCODE_RESOURCE_ATTRIBUTES`          | 同名字段覆盖默认值时仍须符合标准字段的类型和语义。                  |

当前实现使用 `node:os` 的 `platform()` 与 `machine()`：平台按 `win32 → windows`、`sunos → solaris` 归一化，其余保持原值；主机架构映射 `x86_64` / `AMD64 → amd64`、`aarch64` / `arm64 → arm64`、`i386` / `i686 → x86`、`armv7l → arm32`，未识别的架构省略。没有使用进程架构 `process.arch` 代替主机架构。实现见 [telemetry factory](../../src/telemetry/factory.ts)。

启用遥测时，插件通过 OpenCode client 的请求通道查询一次 `/global/health`，将响应中的非空 `version` 写入 `service.version`。查询超时（1 秒）、失败或版本缺失时省略该字段，不影响后续采集。自定义 resource 属性仍可覆盖 `service.name` 和 `service.version`。

Instrumentation scope：

| 字段    | 值                  |
| ------- | ------------------- |
| name    | `opencode-observer` |
| version | 当前插件包版本      |

Scope 的名称和版本均读取插件 `package.json`，随构建嵌入产物。

### 2.2 公共 attributes

| 字段                         | 类型   | 出现条件               | 说明                                                                                                                        |
| ---------------------------- | ------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `session.id`                 | string | 所有 span 必有         | OpenCode session ID；也是 OTel 标准会话关联字段。                                                                           |
| `gen_ai.conversation.id`     | string | 所有 span 必有         | 与 `session.id` 相同，用于 GenAI 会话关联。                                                                                 |
| `opencode.session.parent_id` | string | 父 session 可识别时    | subagent 的父 session ID。不能改为表示“前一个会话”的 `session.previous_id`。                                                |
| `user.id`                    | string | 已发起查询或配置身份时 | 来自初始化时的 `spanAttributes`，静态配置优先于查询结果；查询失败且没有静态身份时为 `unknown`，未查询且没有静态身份时省略。 |
| `<custom-span-attribute>`    | string | 配置存在时             | 来自 `OPENCODE_SPAN_ATTRIBUTES`；除 `user.id` 外，不能覆盖插件维护的身份、类型、标准操作值或其他派生字段。                  |

子 agent 的所有 span 使用自己的 `session.id` 和 `gen_ai.conversation.id`，父 session ID 只记录在 `opencode.session.parent_id`。[Session 字段][otel-session]、[User 字段][otel-user]

`user.id` 由插件入口在初始化阶段直接调用独立 user 模块解析，使用 `OPENCODE_USER_ID_TOKEN` 调用 `OPENCODE_USER_ID_ENDPOINT`，从成功响应的 `result.ssicNo` 取得 ID；接口返回空值或 `unknown` 时视为未取得有效身份。入口等待查询和重试完成后，将有效 ID 合并进 `spanAttributes`；静态配置的 `user.id` 始终优先于查询结果。没有静态配置时，查询最终失败使用 `unknown` 兜底，因开关关闭、地址无效或 token 为空而跳过查询则省略。七类 span 从创建起统一使用此配置快照，tracker 和观测契约不传递用户身份。正文采集开关不控制该属性，身份不会自动刷新或写入 resource。模型请求头中的动态身份传播由 adapter 单独完成，规则见第 3.3 节。配置与重试规则见 [README](../../README.md#用户身份解析)。

默认每个 span 最多保留 4096 个 attributes，可通过 `OPENCODE_SPAN_ATTRIBUTE_COUNT_LIMIT` 调整。超过限制时由 OTel SDK 丢弃多余字段；此数量上限不代表单个属性值或整个 OTLP 请求可以无限大。

## 3. Trace 拓扑

### 3.1 主会话

```text
opencode.run                         invoke_workflow / INTERNAL
└── opencode.interaction             invoke_agent / INTERNAL
    ├── opencode.llm                 chat 等实际操作 / CLIENT
    ├── opencode.tool.<tool-name>    execute_tool / INTERNAL
    │   └── opencode.permission.check             INTERNAL
    ├── opencode.skill.load          execute_tool / INTERNAL
    │   └── opencode.permission.check             INTERNAL
    └── opencode.compaction                       INTERNAL
        └── opencode.llm             chat 等实际操作 / CLIENT
```

- 一个 `run` 对应 session 中一个任务的执行周期，一个 `interaction` 对应任务中的一次真实用户交互。
- 同一个 run 可以包含多个 interaction。用户通过 steer 输入新的消息时，创建新 interaction，run 保持打开。
- steer 到来时，旧 interaction 正常结束，status 保持 `UNSET`，结束时间等于新 interaction 的开始时间；正文开启时输出为空消息数组 `[]`，不保留中途生成的文本。
- interaction 以 owner 用户消息 ID 为稳定标识，可包含多次 LLM 请求、工具调用和自动压缩。
- LLM、tool 和 skill.load span 直接挂在拥有它们的 interaction 下；工具和技能加载不是 LLM span 的子节点。
- `skill` 工具调用只生成 skill.load，不再生成 tool.skill；后续 LLM 和工具仍属于 interaction。
- permission span 只在人工权限请求可以精确关联到活动调用时创建，挂在对应 tool 或 skill.load 下；请求先到达时可在同一 run 内暂存，等待调用开始和归属证据。
- 自动压缩挂在当前 interaction 下；摘要 LLM span 挂在 compaction 下。

### 3.2 前台 subagent

存在 `task` 工具关联信息时：

```text
父 interaction
└── opencode.tool.task
    └── 子 opencode.run
        └── 子 opencode.interaction
            ├── 子 opencode.llm
            └── 子 opencode.tool.<tool-name>
```

子 interaction 使用 `opencode.agent.type=subagent`。父 task tool 的 `gen_ai.tool.call.id` 与 `state.metadata.sessionId` 用于建立 tool call 到子 session 的关联，不额外导出 `task.call_id`。

### 3.3 根上下文与下游传播

- 每个顶层 run 从空上下文创建独立 trace；子 run 通过已关联的 task tool 继承父 trace。
- 插件不读取 `traceparent` / `tracestate` 选项或 `OPENCODE_TRACEPARENT` / `OPENCODE_TRACESTATE` 环境变量。
- 遥测开启时，在可唯一关联的模型请求中注入当前 LLM span 的 W3C `traceparent`，使用该 span 的 trace ID、span ID 和采样标记。遥测层将非空 `traceState` 序列化为 `tracestate`；当前默认根上下文没有该值。
- `OPENCODE_USER_ID_ENABLED` 同时控制动态身份查询和 adapter 的出站身份写入，默认开启。开启时在 `tracestate` 首位写入 `user_id=<动态查询结果>`；配置不完整、结果缺失、查询失败或 ID 无法合法表示时写入 `user_id=unknown`，不使用静态 span 属性兜底。ID 去除首尾空白后须为不含逗号或等号的 1～256 个可打印 ASCII 字符。已有同键替换，其余厂商项顺序保留，最多 32 项。身份拼装只发生在 adapter，不回写 SpanContext 或 OTLP traceState；关闭开关时只传播原有 trace 上下文。
- 下游传播不依赖正文采集开关。AI SDK 和 native LLM 路径均在 `chat.headers` 准备字段，但当前 OpenCode native HTTP 层会另行注入并覆盖 traceparent，尚不能保证下游关联到本插件 trace；native 自动回退到 AI SDK 时可正常传播。标题、未知或歧义归属、缺少父节点的调用省略注入。模型配置、其他插件及底层传输的同名 headers 冲突处理暂未覆盖。

## 4. Span 总览

所有 span 均包含第 2.2 节的公共属性。下文属性表只列各 span 的额外字段；公共错误规则见第 12 节。

| Span 名称                  | OTel kind  | `gen_ai.operation.name`      | 常规 parent                            | 创建数量                                                            |
| -------------------------- | ---------- | ---------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `<prefix>run`              | `INTERNAL` | `invoke_workflow`            | 无（顶层）或父 `task` tool             | session 中每个任务执行周期 1 个                                     |
| `<prefix>interaction`      | `INTERNAL` | `invoke_agent`               | 当前 session 的 run                    | 每次真实用户交互 1 个                                               |
| `<prefix>compaction`       | `INTERNAL` | 不设置                       | interaction                            | 每次压缩 1 个                                                       |
| `<prefix>llm`              | `CLIENT`   | `chat` 或 `generate_content` | interaction、compaction                | 每条有请求准备或模型 step 证据的 assistant message 1 个，覆盖其重试 |
| `<prefix>tool.<tool-name>` | `INTERNAL` | `execute_tool`               | 所属 assistant message 的 interaction  | 每次普通 tool call 1 个，不含 `skill`                               |
| `<prefix>skill.load`       | `INTERNAL` | `execute_tool`               | 所属 assistant message 的 interaction  | 每次 `skill` tool call 1 个                                         |
| `<prefix>permission.check` | `INTERNAL` | 不设置                       | 精确关联的活动 tool 或 skill.load span | 每次可关联的人工权限检查 1 个                                       |

`gen_ai.operation.name` 不是 OTel `SpanKind` 的替代品。run 表示工作流执行，interaction 表示本地 agent 调用；compaction 和 permission 是普通 OTel 内部操作，本基线没有可直接对应它们的 GenAI 标准操作值，不伪造 `CHAIN`、`GUARDRAIL` 或新的标准操作值。[Agent / workflow span 规范][genai-agents]、[模型 / tool span 规范][genai-spans]

## 5. `<prefix>run`

### 5.1 Attributes

| 字段                     | 类型         | 出现条件                         | 值与口径                                                                           |
| ------------------------ | ------------ | -------------------------------- | ---------------------------------------------------------------------------------- |
| `gen_ai.operation.name`  | string       | 必有                             | `invoke_workflow`。                                                                |
| `opencode.run.id`        | string       | 必有                             | 本次任务执行的首个真实用户消息 ID；不是 provider response ID。                     |
| `gen_ai.input.messages`  | string(JSON) | 正文开启且任务内所有用户文本可用 | 按 interaction 顺序记录工作流收到的用户消息，采用第 8.2 节的 `role + parts` 结构。 |
| `gen_ai.output.messages` | string(JSON) | 正文开启、任务正常结束且答复已知 | 最后一个 interaction 的最终答复消息数组。                                          |

消息结构示例见[期望规范 §5](trace.md#5-prefixrun)。这里记录工作流层面的输入，LLM span 上的同名字段记录实际模型请求内容，两者观察范围不同。

run 和 interaction 只聚合真实用户文本及最终 assistant 文本，过滤 synthetic / ignored 文本和压缩摘要。只有附件而没有可用文本的用户输入不伪造空文本：对应 interaction 省略输入属性，包含此类输入的 run 省略整个 `gen_ai.input.messages`，避免将不完整输入表示为完整任务。未知或未完成的输出省略，明确观察到的空文本输出保留。

### 5.2 生命周期

- 开始时间为本次任务首个用户消息的创建时间。
- 正常结束以 `session.status` 的 `status.type=idle` 判断，兼容已弃用的 `session.idle`；两者可能连续到达，必须去重结束。status 保持 `UNSET`。
- 终止性 `session.error` 或无法恢复的 context overflow 导致 `ERROR` 结束，记录 `error.type` 和 status message。

## 6. `<prefix>interaction`

### 6.1 Attributes

| 字段                      | 类型         | 出现条件                              | 值与口径                                                           |
| ------------------------- | ------------ | ------------------------------------- | ------------------------------------------------------------------ |
| `gen_ai.operation.name`   | string       | 必有                                  | `invoke_agent`。                                                   |
| `opencode.interaction.id` | string       | 必有                                  | owner 用户消息 ID。                                                |
| `gen_ai.agent.name`       | string       | 必有                                  | 用户消息指定的 agent 名称。                                        |
| `opencode.agent.type`     | string       | 必有                                  | `primary` 或 `subagent`。                                          |
| `gen_ai.input.messages`   | string(JSON) | 正文开启且用户文本可用                | 单条 `role=user` 消息；拼接后的用户文本放在 `parts[].content` 中。 |
| `gen_ai.output.messages`  | string(JSON) | 正文开启，且正常答复已知或 steer 结束 | 正常答复为最终 assistant 消息；steer 结束时为 `[]`。               |

实际生成了空文本答复时可以记录 `[{"role":"assistant","parts":[{"type":"text","content":""}]}]`；steer 的 `[]` 表示这次交互没有最终答复。正文关闭或数据未知时省略属性，不能用 `[]` 表示“未采集”。

### 6.2 生命周期

- 开始时间为 owner 用户消息的 `time.created`。synthetic 自动续接消息和 compaction marker 用户消息不会创建 interaction；v1 的 `synthetic` 位于 text part 上，不能读取不存在的 message 级字段。含真实用户输入的混合消息仍创建 interaction。
- 收到同一 run 的新 steer 用户消息时，旧 interaction 正常结束，结束时间严格等于新 interaction 的开始时间，status 保持 `UNSET`；正文开启时写入 `gen_ai.output.messages=[]`。
- 未被 steer 结束的 interaction 在 session idle 时结束，结束时间使用插件观察到 idle 的时间，与所属 run 一致。
- 对应用户消息最后一次非摘要 assistant 的 `time.completed` 仅用于判断回复是否完成，不作为 span 结束时间。若缺少该字段，或只有 `tool-calls` 而未取得最终答复，则以 `ERROR` 清理，`error.type=_OTHER`，status message 为 `session ended before interaction completed`；不回退到更早 assistant 的答复。已确认完成但未采集正文时仍可正常结束，省略输出属性。
- 旧 interaction 结束后不再回填输出或修改结束时间。已归属旧 interaction 的 LLM/tool/skill.load span 保持原 parent，即使其完成事件晚于 steer 到达，也不改挂到新 interaction。
- 发生终止错误时以 `ERROR` 结束。可恢复的 context overflow 期间保持打开。

## 7. `<prefix>compaction`

### 7.1 Attributes

| 字段                                     | 类型    | 出现条件                  | 值与口径                                                                    |
| ---------------------------------------- | ------- | ------------------------- | --------------------------------------------------------------------------- |
| `gen_ai.agent.name`                      | string  | agent 可识别时            | 所属 interaction 的 agent 名称。                                            |
| `opencode.agent.type`                    | string  | agent 类型可识别时        | 所属 interaction 的 `primary` 或 `subagent`。                               |
| `opencode.compaction.id`                 | string  | 必有                      | compaction marker 用户消息 ID。                                             |
| `opencode.compaction.auto`               | boolean | 必有                      | 是否为自动压缩。                                                            |
| `opencode.compaction.overflow`           | boolean | 必有                      | compaction part 的 `overflow === true`；源字段缺省时为 `false`。            |
| `opencode.compaction.trigger_message.id` | string  | overflow 触发且消息可识别 | 发生 overflow 的 assistant message ID。                                     |
| `opencode.compaction.prompt_tokens`      | int     | 压缩成功且摘要 usage 可用 | 摘要 assistant 的 `tokens.input + tokens.cache.read + tokens.cache.write`。 |
| `opencode.compaction.summary_tokens`     | int     | 压缩成功且摘要 usage 可用 | 摘要 assistant 的 `tokens.output`，保留“不包含 reasoning”的原业务口径。     |

`gen_ai.usage.*` 标准用量字段只在对应的子摘要 LLM span 上导出，口径见第 8 节。compaction 仅保留上述 prompt / summary tokens 业务字段，不能与子 LLM 相加统计总消耗。具体写入见 [compaction spans](../../src/telemetry/spans/compaction.ts)。

### 7.2 生命周期

- 开始时间优先使用 compaction marker 用户消息创建时间，否则使用当前观察时间。
- 收到 `session.compacted` 时正常结束，status 保持 `UNSET`。该事件只有 `sessionID`，不携带 compaction ID 或 token usage，需与该 session 的活动 compaction 和摘要 assistant 关联。
- 压缩期间又出现 context overflow、被新的压缩覆盖、会话终止或摘要 assistant 出错时，以 `ERROR` 结束。
- 摘要 LLM span 携带相同 `opencode.compaction.id`，并以 compaction span 为 parent。

## 8. `<prefix>llm`

### 8.1 身份、模型和用量

| 字段                                    | 类型     | 出现条件                             | 值与口径                                                                                                                                                           |
| --------------------------------------- | -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gen_ai.operation.name`                 | string   | 必有                                 | `chat.params` 根据 Google / Google Vertex SDK 包名选择 `generate_content`，其他为 `chat`；无请求配置时按归一化 provider 选择。当前适配层不产生 `text_completion`。 |
| `gen_ai.provider.name`                  | string   | 必有                                 | 已知 provider ID 优先映射标准名，其次匹配 SDK 包名，未识别时保留原始 provider ID。                                                                                 |
| `gen_ai.request.model`                  | string   | 必有                                 | 优先取 `chat.params` 的 `model.api.id`，缺失请求配置时取 assistant 的 model ID。                                                                                   |
| `gen_ai.response.model`                 | string   | 取得当前 SDK step 的响应模型时       | 直接取 AI SDK `onStepFinish` 的 `event.response.modelId`，不受 `captureContent` 控制；该值可能包含 SDK 自身的请求模型兜底。                                        |
| `opencode.message.id`                   | string   | 必有                                 | OpenCode assistant message ID。                                                                                                                                    |
| `opencode.compaction.id`                | string   | 摘要调用                             | 摘要 assistant 的 parent message ID，与父 compaction marker ID 相同。                                                                                              |
| `gen_ai.agent.name`                     | string   | agent 可识别时                       | 优先使用 assistant 的 `agent`，兼容 `mode`；未知时省略。                                                                                                           |
| `opencode.agent.type`                   | string   | 必有                                 | `primary` 或 `subagent`。                                                                                                                                          |
| `gen_ai.usage.input_tokens`             | int      | 模型请求成功且 usage 可用            | OpenCode 归一化后的 `tokens.input + tokens.cache.read + tokens.cache.write`，包含缓存输入。                                                                        |
| `gen_ai.usage.output_tokens`            | int      | 模型请求成功且 usage 可用            | OpenCode 归一化后的 `tokens.output + tokens.reasoning`，包含 reasoning。                                                                                           |
| `gen_ai.usage.reasoning.output_tokens`  | int      | 模型请求成功且对应 usage 可用        | `tokens.reasoning`，是 output tokens 的子集。                                                                                                                      |
| `gen_ai.usage.cache_read.input_tokens`  | int      | 模型请求成功且对应 usage 可用        | `tokens.cache.read`，是 input tokens 的子集。                                                                                                                      |
| `gen_ai.usage.cache_write.input_tokens` | int      | 模型请求成功且对应 usage 可用        | `tokens.cache.write`，是 input tokens 的子集；本基线使用 `cache_write`。                                                                                           |
| `opencode.llm.cost.total`               | double   | 模型请求成功且 cost 可用             | OpenCode `step-finish` 的 `cost`，单位 USD。通常为计价估算；缺少价格时源数据可能为 `0`，不代表账单实付金额。                                                       |
| `gen_ai.response.finish_reasons`        | string[] | 存在结束原因，或生成异常终止         | 当前为单候选数组，正常取 `step-finish.reason`，清理时可使用已知的 `assistant.finish`；异常缺失结束原因时写入 `["error"]`。                                         |
| `gen_ai.response.time_to_first_chunk`   | double   | 取得所选 LLM 起点和首次 `step-start` | 秒。首次 OpenCode `step-start` 减去最终所选 message/fetch 起点；起点不随重试重置，包含首个 step 前的重试和退避，不要求非空文本。                                   |

上述 usage 读取有效 `step-finish` 的 `tokens`，不读取 assistant 初始化零值；公式只适用于 OpenCode 已归一化的数据。input 总量要求 input / cache read / cache write 均有效，output 总量要求 output / reasoning 均有效；缺少分量时省略对应总量，仍可保留其他有效分量。如果另取 provider 原始 usage，需先理解缓存和 reasoning 是否已包含在总量中，不能再次相加。总 token 数直接由 input + output 计算，不另造 `gen_ai.usage.total_tokens`。源 usage/cost 不保证包含所有失败 attempt 的消耗，不能描述为完整重试账单。实现见 [usage 归一化](../../src/adapter/model/usage.ts)、[模型配置映射](../../src/adapter/model/request.ts)和 [LLM attributes](../../src/telemetry/spans/llm.ts)。

`gen_ai.response.model` 使用当前 step 的 SDK 回调值，新请求快照清除上一 step 的响应模型。未取得回调或字段缺失时省略，插件不自行用请求模型补值。AI SDK 在 provider 未提供响应模型时可能返回请求模型，因此本实现不保证该值由服务端响应确认；这是相对于期望规范的语义降级。

`gen_ai.response.finish_reasons` 按返回候选顺序排列，不能把各次 retry 的 finish reason 混入这个数组。正文数组经过过滤时，finish reasons 仍对应原候选顺序。不再把 `finish_reason` 写到输出消息对象中，该 JSON 属性在本基线已弃用。

首 chunk 耗时是明确降级的近似值，由 `llmTimingMode` 选择起点：`message` 为 `(首次 step-start 时间 − assistant.time.created) / 1000`，`fetch` 为 `(首次 step-start 时间 − 首次关联 fetch 开始时间) / 1000`。fetch 边界不足而整体回退时，首块耗时同步使用消息起点；实际起点来源见 `opencode.llm.timing.source`。终点优先取 `message.part.updated.properties.time`（OpenCode 发布该 part 的时间），缺失或无效时取插件接收时间，不使用 fetch 响应体首块。

当前 AI SDK 在收到首个非 `stream-start` 的流事件时生成 `start-step`，可能由响应元数据、reasoning、工具调用甚至流内错误触发，不要求非空文本或模型成功。OpenCode 再转换并发布 `step-start`，发布前还可能等待工作区快照，因此该值包含流处理、调度和事件发布前的延迟，回退到接收时间时还包含事件分发延迟，没有固定误差上限。

同一逻辑 LLM 只保留首次 step 观察，SDK 重新绑定、重试和后续 step 都不重置。该计时不依赖 SDK 回调，native 路径具备所需消息和 step 证据时也可采集。首次 step 时间早于最终所选起点、时间无效或终止前没有首个 step 时省略；不以稍后的 step 或首个文本补值。首个 step 后失败仍保留已观察到的耗时。该字段及来源标记不受 `captureContent` 控制。

### 8.2 消息与系统指令

| 字段                     | 类型         | 出现条件                           | 值与口径                                                                                              |
| ------------------------ | ------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `gen_ai.input.messages`  | string(JSON) | 正文开启且取得输入内容             | 使用 GenAI InputMessages 结构；实际请求消息按发送顺序记录。                                           |
| `gen_ai.output.messages` | string(JSON) | 正文开启且取得输出内容或确认空输出 | 使用 GenAI OutputMessages 结构；每个元素代表一个输出候选，该候选的多个内容片段放在同一 `parts` 数组。 |

消息采用期望规范约定的 InputMessages / OutputMessages 结构，系统指令保留在 input messages 的 `role=system` 消息中，不单独导出系统指令字段。工具调用、工具响应和系统指令示例统一见[期望规范 §8.2](trace.md#82-消息与系统指令)。

转换和降级规则：

- 当前实现从 AI SDK `onStepStart.messages` 采集 SDK 可见的请求消息，保留其中的系统消息，不额外读取独立 `system` 或 provider `instructions`。从 `onStepFinish.content` 采集当前 step 的生成内容；只在后者不可用时取 `response.messages` 的最后一个 assistant。输出不包含历史 step 或本地工具执行结果。采集通道和关联约束见 [适配层设计 §3](../adapter.md#3-llm-关联与采集)。
- OpenAI 风格的 `content` / `tool_calls` 要转换为 GenAI `parts`；不能只改外层 attribute key。工具调用的 `arguments` 尽量解析为结构化 JSON，并保持 call ID 与工具 span、工具结果消息一致。
- 保留文本、tool call、tool response 等已采集片段的顺序；多模态内容按相应 part schema 处理。文本的类型由 `type=text` 表达，不再导出通用的 input/output MIME attributes。
- reasoning 使用 `reasoning` part；媒体 URL 使用 `uri`，二进制和 data URI 使用 base64 `blob`。不下载媒体内容，不将未知片段或整个 SDK 对象作为正文透传。
- 未取得完整 AI SDK lifecycle 数据时，输入 fallback 只记录 owner 用户消息文本，输出 fallback 只记录可观察到的 assistant 文本，二者仍转换为相同 GenAI 消息结构。此时不表示取得了完整系统提示词、历史上下文或原始响应。
- 不在 LLM span 创建时预填空输出数组；尚未观察到输出应省略。已知没有返回候选时可以记录 `[]`，实际空文本候选可以记录一个内容为空的 text part。

### 8.3 请求参数、工具定义和 HTTP 属性

原先聚合在 invocation JSON 中、有标准对应项的参数拆成独立 attributes。只写入实际取得的有效值，不把未配置参数的假定默认值当作实测值。

`gen_ai.output.type` 独立于正文采集开关。工具定义与输入输出正文共用 `captureContent`；模型请求／响应 HTTP headers（含错误响应）要求 `captureContent` 和 `captureHttpHeaders` 同时开启，两个开关默认关闭。`gen_ai.request.seed` 不采集。

| 字段                         | 类型         | 来源                                                                                                                                                                              |
| ---------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen_ai.request.max_tokens`  | int          | `chat.params` 输出中的有效 `maxOutputTokens`。                                                                                                                                    |
| `gen_ai.request.temperature` | double       | `chat.params` 输出中的有效 `temperature`。                                                                                                                                        |
| `gen_ai.request.top_p`       | double       | `chat.params` 输出中的有效 `topP`。                                                                                                                                               |
| `gen_ai.request.top_k`       | int          | `chat.params` 输出中的有效 `topK`。                                                                                                                                               |
| `gen_ai.request.stream`      | boolean      | 当前适配的 OpenCode 模型路径按流式调用记录，固定为 `true`。                                                                                                                       |
| `gen_ai.output.type`         | string       | 取得 AI SDK 显式 `output.responseFormat.type` 时记录 `text` 或 `json`；SDK 回调确认未配置 `output` 时记录默认值 `text`；没有 SDK 快照、显式格式未就绪、解析失败或无法识别时省略。 |
| `gen_ai.tool.definitions`    | string(JSON) | `captureContent=true` 时，取得当前 SDK step 经 `activeTools` 筛选的工具定义。                                                                                                     |
| `http.request.header.<key>`  | string[]     | `captureContent=true` 且 `captureHttpHeaders=true` 时取得的 SDK step 请求 headers；key 为小写 header 名。                                                                         |
| `http.response.header.<key>` | string[]     | `captureContent=true` 且 `captureHttpHeaders=true` 时取得的 SDK 响应或可关联 API 错误的响应 headers；key 为小写 header 名。                                                       |

`gen_ai.tool.definitions` 使用期望规范的 ToolDefinitions 结构，示例见[期望规范 §8.3](trace.md#83-请求参数工具定义和-http-属性)。函数工具直接使用顶层 `type=function` / `name`，不能保留 OpenAI 的外层 `function` 包装；开启 `captureContent` 后一并记录可取得的 `description` 和 `parameters`。参数定义使用 AI SDK 的 Schema 转换结果，采用 JSON Schema draft-07；转换失败时保留工具身份并省略参数，不影响其他工具。provider 工具使用 SDK 的 provider tool ID 作为 `type`，保留调用名称 `name`，不伪装成函数工具。已知有效工具集合为空时记录 `[]`，没有工具快照时省略。

HTTP header 示例是原生 attribute 值：`http.request.header.content-type=["application/json"]`。即使只有一个值也必须是 `string[]`，保留 header 名中的连字符；多值按 HTTP 库提供的形式记录，不能任意按逗号拆分。[HTTP 字段规范][otel-http]

请求 headers 反映 SDK 可见值，不补造 provider 或底层 HTTP 库稍后追加的 headers；响应 headers 不要求成功状态，但必须能关联到对应 LLM。内部关联标识 `x-opencode-observer-request` 不采集。模型 headers 与 `otlpHeaders` 配置的 collector 导出 headers 相互独立。

工具定义、输出类型和 SDK headers 使用当前 step 的快照；新请求清理旧工具定义、输出类型和响应 headers。不能取得 SDK 回调（例如 native 路径）时省略相应字段，不根据工具执行记录、回答文本或其他请求推测。`chat.params` 取得的参数在 LLM 创建时写入，不是逐 step 更新的 SDK 快照。异步解析、快照提交及迟到结果处理见 [适配层设计 §3.3](../adapter.md#33-数据转换与快照提交)。

### 8.4 Retry attributes

| 字段                       | 类型 | 出现条件       | 值与口径                                                                          |
| -------------------------- | ---- | -------------- | --------------------------------------------------------------------------------- |
| `opencode.llm.retry_count` | int  | 必有，初始 `0` | OpenCode retry 通知中已记录的最大有效 attempt，不含初次执行，包含仍在退避的重试。 |

采集范围为 **OpenCode session processor 的重试流程**，不统计 AI SDK、鉴权插件、provider 或传输层内部的请求重发，也不要求探测网络请求边界。适配层将 `session.status` 的 retry 通知绑定到同一 run 下唯一可识别的活动 assistant，直接使用其中的 `attempt` 更新次数。摘要调用采用相同规则；归属未知或歧义时忽略该通知，不根据其他 session 或新 assistant 的活动补计。

`attempt` 必须是正的安全整数，仅接受大于已记录次数的值；重复或较旧序号忽略。收到通知即更新，无需等待 busy；即使跳过中间通知，也直接使用后续收到的有效 attempt。退避期间取消、终止、删除或关闭仍保留已记录次数，因此该字段表示 OpenCode 通知的重试次数，不保证对应请求已实际发出。`0` 表示没有记录到 OpenCode 重试，不保证底层没有重发。

重试仅导出上述计数，不读取、保留或导出重试历史、原因、预计时间、观察时间及偏移量。计数不受 `captureContent` 或 `llmTimingMode` 控制；切换 LLM 起止时间或首块耗时口径不会改变计数。

### 8.5 生命周期与状态

- 仅为有请求准备或模型 step 证据的 assistant message 创建 span。OpenCode 的 subtask / 命令路径也可能直接构造 assistant message，不能仅凭 `role=assistant` 创建 LLM span。
- `llmTimingMode=message`（默认）以 `assistant.time.created` 开始，正常以 `assistant.time.completed` 结束。这是 assistant 消息生命周期，包含请求准备、重试退避、工具执行和清理。
- `llmTimingMode=fetch` 以同一 assistant 的首次已关联 fetch 调用开始，最后一次响应体 EOF、请求／读取异常或取消结束；无 body 时取 response 返回时间。包含两次请求之间的退避，排除响应体结束后的工具执行与消息清理。fetch Promise resolve 不是流完成；HTTP EOF 也不是模型协议成功。该模式不解析正文，不测服务端推理时间，仍受客户端缓冲和背压影响。时间戳使用毫秒级本地墙钟，系统校时可能影响差值；检测到无效或倒退边界时回退至消息口径。
- fetch 缺失或边界不完整时，开始和结束一起回退至 message 口径；不将消息起点和 fetch 终点混用。可见范围取决于 provider 是否经过本插件的进程级 fetch 包装器并保留已关联 traceparent。
- 当前实现优先在 `chat.headers` 唯一匹配 assistant 和 parent 后创建 span，以便发送前传播上下文；未取得该关联时，等待 `step-start` 和消息归属证据。初始起点取消息的 `time.created`；fetch 模式在导出前使用已观察的时间校准，span ID 不变。缺失或无效的消息创建时间不补造 span；只有完成消息或结束事件、没有请求准备或 step 开始证据时也不创建 span。
- `step-finish` 提供结束原因、用量和费用，不提供 span 结束时间。消息完成与 step 结果乱序时分别暂存；成功结果仍等待已绑定的 SDK 输出，再以选定时间提交结束。结束时间必须有效且不早于起点，重复通知和迟到更新不得改写已结束 span。
- 取得所选 LLM 起点和首次 OpenCode `step-start` 时，按第 8.1 节导出首 chunk 近似耗时；证据缺失或时间无效时省略。不导出精确的 attempt 级耗时，也不用首个 assistant 文本事件补值。
- 正常完成保持 `UNSET`，provider / OpenCode 错误终止时设置 `ERROR`、`error.type` 和 status message。重试后成功的逻辑 LLM span 不残留终态 `error.type` 或 `ERROR`；已记录重试次数保留。
- session 或插件收尾时，已取得消息完成时间但仍等待 SDK 输出或 step 结果的调用，保留该完成时间和已知结果，省略缺失内容及用量；不因采集回调缺失而把已完成调用标为失败。仍未取得消息完成时间的调用以 `ERROR` 清理，status message 为 `session ended before message completed` 或具体终止原因。

时间来源属性：

| 字段                                  | 类型   | 口径                                                                                                        |
| ------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `opencode.llm.timing.source`          | string | 最终采用的口径：`message` 或 `fetch`。                                                                      |
| `opencode.llm.timing.fallback_reason` | string | 仅 fetch 模式回退时出现：`fetch-unobserved` 表示没有取得请求起点，`fetch-incomplete` 表示边界不完整或无效。 |

首 chunk 近似指标使用最终导出的 span 起点，但终点仍是 OpenCode `step-start`，可能包含响应体 EOF 之后的本地处理延迟，因此可以大于 fetch span 的持续时间，不能用它反推网络首字节时间。

以下为 message 口径的异常边界。fetch 模式取得完整边界时改用 fetch 时间，错误状态仍遵循相同生命周期规则；边界不足时按表中时间回退：

| 场景                                           | 时间与状态                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| 错误或取消的 assistant 更新已包含 completed    | 使用消息创建、完成时间，保留具体错误。                                       |
| session.error 先于 completed 到达              | 立即按错误观察时间收尾；不延迟宿主，也不等待可能永不到达的完成更新。         |
| step-finish 已到达，但 idle 时仍没有 completed | 使用 idle 观察时间，以消息未完成错误收尾；不能把 step 完成当作消息完成。     |
| 已有 completed，SDK 输出或 step 结果未到达     | 收尾时保留消息完成时间；只保留已有的数据，不填入初始化零用量。               |
| 消息删除、压缩结束或插件关闭                   | 优先保留已有消息完成时间；缺失时按对应终止观察时间和错误收尾。               |
| 重试后成功                                     | 同一 assistant 仍只有一个 span，从消息创建到完成；包含退避，不残留终态错误。 |
| 可恢复的上下文溢出                             | 失败的 LLM 调用独立结束，run / interaction 可继续执行压缩和后续调用。        |
| 进程被强杀或崩溃，未执行 dispose               | 不保证活动 span 能结束或导出，不补造完成时间。                               |

## 9. `<prefix>tool.<tool-name>`

### 9.1 Attributes

| 字段                         | 类型         | 出现条件                  | 值与口径                                                                          |
| ---------------------------- | ------------ | ------------------------- | --------------------------------------------------------------------------------- |
| `gen_ai.operation.name`      | string       | 必有                      | `execute_tool`。                                                                  |
| `gen_ai.tool.call.id`        | string       | 必有                      | tool part 的 `callID`，不是 part 的 `id`。                                        |
| `gen_ai.tool.name`           | string       | 必有                      | tool part 的 `tool`，同时参与 span 名称。                                         |
| `gen_ai.tool.description`    | string       | 正文开启且 SDK 调用可关联 | 当前 SDK step 的工具描述，通过工具执行回调的调用 ID 和名称与 tool part 精确关联。 |
| `gen_ai.tool.call.arguments` | string(JSON) | 正文开启且参数可用        | tool part 的 `state.input` 对象。                                                 |
| `gen_ai.tool.call.result`    | string(JSON) | 正文开启且 tool 成功完成  | `state.output` 经下述规则转换后的结果对象；失败时不填写此属性。                   |
| `gen_ai.agent.name`          | string       | 所属 agent 可识别时       | 所属 assistant 的 `agent`，兼容 `mode`；未知时省略。                              |
| `opencode.agent.type`        | string       | 完成后的 span 必有        | `primary` 或 `subagent`。                                                         |

参数和结果分别遵循 [ToolCallArguments][genai-tool-args-schema] / [ToolCallResult][genai-tool-result-schema] JSON Schema。本基线要求对象：`state.output` 若可解析为 JSON 对象，则使用该对象；否则使用插件定义的 `{ "content": state.output }` 包装，保留原始文本。`content` 是本插件结果对象的约定，并非新增的 GenAI attribute。

工具描述来自 `onStepStart` 中经 `activeTools` 筛选后的工具快照，不等待参数 schema 解析；`onToolCallStart` 将描述关联到相同 run、assistant message、call ID 和工具名称。无法绑定 SDK 调用、未取得描述或工具已经结束时省略，不从名称或调用参数中的 `description` 推断。native 路径和未触发 SDK 工具执行回调的调用不保证取得描述。`skill.load` 不导出此字段。

参数示例：

```json
{ "filePath": "package.json" }
```

文本工具结果的转换示例：

```json
{ "content": "配置文件内容" }
```

失败的 `state.error` 写入 span status message，`error.type` 记录错误分类；不将错误文本伪装为成功工具结果。不再导出重复的 `tool.success`，成功/失败由 span 的结束状态判断。

### 9.2 生命周期与状态

- 开始/结束时间来自 tool state 的 `time.start` / `time.end`。
- 工具归属通过 tool part 的 `messageID` 查找 assistant，再由 assistant 的 `parentID` 关联 owner 用户消息；不能在完成事件到达时直接使用当前 interaction。
- `completed` 时正常结束，status 保持 `UNSET`；`error` 时设置 `ERROR`，status message 为 tool error 文本。
- `state.error` 只有文本，不含结构化异常类型。已关联的人工权限拒绝导致失败时使用 `error.type=PermissionRejectedError`；普通工具执行失败使用 `ExecutionError`；无法归类的清理错误使用 `_OTHER`。这些具体错误分类是插件约定，attribute key 是 OTel 标准。
- 缺失 `running` 事件时，完成事件补建 span 后立即结束。
- session 结束但 tool 未完成时，以 `ERROR` 清理，status message 为 `session ended before tool completed`；完成态字段可能不存在。

## 10. `<prefix>skill.load`

### 10.1 Attributes

| 字段                              | 类型    | 出现条件             | 来源与说明                                                                                                    |
| --------------------------------- | ------- | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `gen_ai.operation.name`           | string  | 必有                 | `execute_tool`，与工具调用一致。                                                                              |
| `gen_ai.tool.name`                | string  | 必有                 | `skill`。                                                                                                     |
| `gen_ai.tool.call.id`             | string  | 必有                 | tool part 的 `callID`。                                                                                       |
| `gen_ai.agent.name`               | string  | agent 可识别时       | 所属 assistant 的 agent 信息。                                                                                |
| `opencode.agent.type`             | string  | 类型可识别时         | `primary` 或 `subagent`。                                                                                     |
| `opencode.skill.name`             | string  | 名称为非空字符串时   | 从 `state.input.name` 提取；成功快照中的有效 `state.metadata.name` 优先确认或补充。                           |
| `ai.agent.skill.name`             | string  | 名称为非空字符串时   | 与 `opencode.skill.name` 同源、同值并同步更新；不受 `captureContent` 控制，不能由自定义 span 属性覆盖或补造。 |
| `opencode.skill.directory`        | string  | 成功快照中目录有效时 | `state.metadata.dir`，保留宿主报告的目录，不据此拼接 `SKILL.md`。                                             |
| `opencode.skill.output`           | string  | 正文开启且加载成功   | `state.output` 原始返回文本，明确的空文本保留。                                                               |
| `opencode.skill.output.truncated` | boolean | 成功快照中有布尔值时 | `state.metadata.truncated`，明确的 `false` 保留。                                                             |

名称、目录和截断状态不受 `captureContent` 控制；关闭正文时仍提取名称，但不解析、保留或提交完整参数和返回内容。skill.load 不导出 `opencode.skill.trigger`、`gen_ai.tool.call.arguments` 或 `gen_ai.tool.call.result`；LLM 消息中的 tool call / response 仍按第 8 节采集并通过 call ID 关联。

返回文本可包含技能正文、目录说明和抽样资源列表，也可能经过 OpenCode 截断，不表示完整原始 `SKILL.md`。不额外读盘补全正文，不推导版本、来源分类、完整文件列表、token 或费用。

### 10.2 生命周期与状态

- tool tracker 识别 `part.tool === "skill"` 后提交独立的 `startSkill` / `updateSkill` / `finishSkill` 契约，共用工具调用的归属、去重、权限关联和清理逻辑。
- 起止时间来自 `state.time.start` / `state.time.end`，覆盖这次调用的查找、权限等待、资源枚举和返回处理；技能内容可能已在发现阶段缓存，因此不是纯文件读取耗时。
- `pending` 不创建 span；首次取得有效 running 或终态快照后，等待 assistant → owner 用户消息确定 interaction。缺少 running 事件时可按终态的源时间补交开始和结束；steer 后不改挂父节点。
- `completed` 正常结束并保持 `UNSET`；`error` 使用 `ERROR` 和 `ExecutionError`，有精确拒绝证据时使用 `PermissionRejectedError`。加载失败不自动使 run 失败。
- part 删除、session 结束或插件关闭时，未完成加载以错误收尾，先清理其权限检查。重复开始、完成及迟到更新不重建或修改已结束 span。
- 当前仅覆盖显式 `skill` 工具调用；技能发现、`/技能名` 命令和普通 read 工具读取技能文件不生成 skill.load。后续模型和工具执行不归入技能加载 span。

实现见 [tool tracker](../../src/adapter/trackers/tool.ts)、[Skill 契约](../../src/contract/observer.ts)和 [skill spans](../../src/telemetry/spans/skill.ts)。

## 11. `<prefix>permission.check`

### 11.1 Attributes

| 字段                               | 类型     | 出现条件       | 值与口径                                                     |
| ---------------------------------- | -------- | -------------- | ------------------------------------------------------------ |
| `gen_ai.agent.name`                | string   | agent 可识别时 | 关联工具所属 assistant 的 `agent`，兼容 `mode`；未知时省略。 |
| `opencode.agent.type`              | string   | 必有           | `primary` 或 `subagent`。                                    |
| `opencode.permission.tool.call.id` | string   | 必有           | 被检查的调用 ID，与父 tool 或 skill.load span 相同。         |
| `opencode.permission.tool.name`    | string   | 必有           | 从对应 tool part 的 `tool` 取得；skill.load 为 `skill`。     |
| `opencode.permission.name`         | string   | 必有           | 权限类型。                                                   |
| `opencode.permission.patterns`     | string[] | 必有           | 请求匹配的 patterns。                                        |
| `opencode.permission.reply`        | string   | 收到 reply     | `once`、`always` 或 `reject`。                               |
| `opencode.permission.granted`      | boolean  | 收到 reply     | reply 不为 `reject` 时为 `true`。                            |

此 span 使用 `opencode.permission.tool.*` 自定义属性引用被检查的工具调用，不设置 `gen_ai.tool.name`、`gen_ai.tool.call.id` 或 `gen_ai.operation.name=execute_tool`。Langfuse 会根据 GenAI tool 名称或调用 ID 推断工具类型，并优先使用工具名作为显示名称；使用自定义属性可避免将权限检查识别为工具执行或覆盖其 span 名称。权限模式、人工决策和 patterns 没有等价的标准 GenAI 字段，保留 OpenCode 扩展。

### 11.2 生命周期与状态

- 开始/结束时间使用本地 `Date.now()`，测量插件观察到的权限等待时间。
- `permission.asked` 的 `id` 与 `permission.replied` 的 `requestID` 配对。asked 中的 `tool` 可选，且只有 `messageID` / `callID`，不包含工具名称；必须精确关联活动 tool 或 skill.load 后才创建 permission span。
- 请求先于调用开始或归属证据到达时，在所属 run 的有界 pending map 中暂存请求字段和原观察时间；答复随后先到时保留首次答复。调用开始后按 message ID / call ID 关联，再补交权限开始和已知答复，并将拒绝结果用于调用错误分类。没有 asked 的先到 reply 不补造请求；始终无法关联的请求在淘汰或 run 收尾时丢弃，不创建 span。
- 收到任何 reply 都表示检查流程正常结束，status 保持 `UNSET`。`reject` 通过 `opencode.permission.granted=false` 表达；随后关联 tool 若因该拒绝而失败，使用 `error.type=PermissionRejectedError`。
- tool、skill.load 或 session 在 reply 前结束，或 pending map 淘汰该请求时，permission span 以 `ERROR` 清理。

## 12. 状态与错误汇总

| Span             | 正常结束 status | 常见 ERROR 条件                                               |
| ---------------- | --------------- | ------------------------------------------------------------- |
| run              | `UNSET`         | 终止 session error、overflow 恢复失败                         |
| interaction      | `UNSET`         | 所属 session / assistant 终止错误                             |
| compaction       | `UNSET`         | 摘要错误、被新压缩覆盖、session 提前结束                      |
| llm              | `UNSET`         | 模型调用最终失败、session 提前结束                            |
| tool             | `UNSET`         | tool error、session 提前结束                                  |
| skill.load       | `UNSET`         | 加载错误、权限拒绝、part 删除或 session 提前结束              |
| permission.check | `UNSET`         | tool / skill.load / session 在 reply 前结束、pending map 淘汰 |

所有 span 共用以下错误规则：

| 字段 / 位置                           | 类型   | 出现条件           | 口径                                                                                                       |
| ------------------------------------- | ------ | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `error.type`（span attribute）        | string | `ERROR` 结束时必有 | 优先用源错误类型或稳定错误码；无法识别且未定义具体分类时用 OTel `_OTHER`。不把完整错误文本当作类型。       |
| `exception.message`（span attribute） | string | `ERROR` 结束时必有 | 与 `status.message` 相同的非空错误摘要，不受 `captureContent` 控制。                                       |
| `status.code`（span envelope）        | enum   | 所有 span          | 正常保持 `UNSET`，失败为 `ERROR`。                                                                         |
| `status.message`（span envelope）     | string | `ERROR` 结束时必有 | 记录非空错误摘要；通过 `setStatus({ code, message })` 写入，不调用 `setAttribute("status.message", ...)`。 |

适配层依次提取非空、非纯空白的 `error.data.message` 和外层 `error.message`，有效文本保留原文。有 `data` 对象且外层 `message` 仅重复错误类型时，不将其作为具体摘要。观测契约中的 `message` 仍可省略；所有 span 在遥测收尾时统一为缺失、空字符串或纯空白摘要补写 `<error.type>: no error message provided`，类型为 `_OTHER` 或空白时使用 `Operation failed: no error message provided`。同一个最终摘要同时写入两个字段；成功 span 不写入这两个字段。

子操作失败不自动使父操作失败：可恢复的 overflow 不结束 run/interaction；最终成功的重试不把逻辑 LLM span 标为失败；人工拒绝不把已完成的 permission 检查标为失败。清理时必须去重，已结束的 span 不再次修改。

## 13. 最小成功 Trace 示例

一次无工具调用的主会话：

```text
opencode.run                  gen_ai.operation.name=invoke_workflow
└── opencode.interaction      gen_ai.operation.name=invoke_agent
    └── opencode.llm          gen_ai.operation.name=chat
```

三个 span 均包含相同的 `session.id` / `gen_ai.conversation.id`，正常结束后 status 保持 `UNSET`。LLM messages 描述单次逻辑模型调用；interaction messages 描述一次用户交互；run input messages 按顺序包含任务内所有 interaction 的用户输入，run output messages 为最后一次 interaction 的最终输出。

## 14. 与期望规范的差距

下表区分当前已实现的有条件采集、近似观测与未实现字段。它不表示一次 trace 应出现所有目标属性，也不将未采集的值视为零。

| 期望内容                              | 当前实现                                                                                                 | 阅读导出数据时的含义                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 完整的前台 task → 子 run 关系         | 条件支持；必须在子 run 创建前确定活动 task tool 关联，否则记录独立根 run。后台任务不建立前台父子关系。   | 父 session ID 不能单独证明 trace parent。                                                           |
| 每次人工权限检查有对应 span           | 条件支持；必须精确匹配 tool 或 skill.load 的 message ID / call ID；支持同一 run 内先到的权限请求及答复。 | 缺少 permission span 不代表没有发生权限流程；也不采集静默授权。                                     |
| LLM 的实际操作类型                    | 当前只映射 `chat` / `generate_content`；契约允许 `text_completion`，适配层未产生该值。                   | operation 来自已识别的配置映射，不是对网络协议的完整探测。                                          |
| `gen_ai.response.id`                  | **未实现**；当前 Observer 契约和 LLM 属性写入均没有响应 ID 通道。                                        | 不应期待此字段；宿主 message ID 不能作为替代。                                                      |
| `gen_ai.response.model`               | 条件支持；直接取 AI SDK `onStepFinish` 的 `event.response.modelId`，不受正文开关控制。                   | SDK 可能用请求模型兜底，不保证由服务端响应确认；缺少 SDK 回调或字段时省略。                         |
| LLM 客户端请求到响应结束的时间        | 默认采用 message 生命周期；可选 fetch 边界，缺失或不完整时整组回退。                                     | 必须结合 `opencode.llm.timing.source`；message 时间包含工具执行，fetch 时间仍不是服务端纯推理时间。 |
| `gen_ai.response.time_to_first_chunk` | **近似观测**；终点是首次 OpenCode `step-start`。                                                         | 包含本地处理延迟；不是精确网络首块时间，可能大于 fetch span 时长。                                  |
| 宿主流程的 `opencode.llm.retry_count` | 已实现；仅接收可唯一关联的 OpenCode retry 通知，取最大有效 attempt。                                     | 是通知计数，可能仍在退避；`0` 不证明底层没有请求重发。                                              |
| 模型完整输入与当前生成内容            | 条件支持；SDK 可见快照优先，缺失时输入/输出分别降级为可见文本。                                          | 不保证是 provider 最终编码的网络请求，也不包含所有重试历史；摘要输入未知时省略。                    |
| 工具定义、输出类型、模型 headers      | 依赖 SDK 快照；未配置 `output` 时记录 SDK 默认输出类型 `text`；可关联的 API 错误也可提供响应 headers。   | 未经过 SDK 的路径缺失相应字段；请求 headers 不包含传输层之后追加的值。                              |
| 可靠的下游 trace 关联                 | AI SDK 路径支持；native HTTP 层可能覆盖已准备的 traceparent。                                            | native 请求尚不能保证关联到插件 trace。                                                             |

当前用于解释降级的扩展字段是 `opencode.llm.timing.source` 和 `opencode.llm.timing.fallback_reason`，具体取值见第 8 节。它们描述观测来源，不替代业务状态或精确测量。

[otel-semconv]: https://github.com/open-telemetry/semantic-conventions/tree/v1.44.0/docs
[otel-errors]: https://github.com/open-telemetry/semantic-conventions/blob/v1.44.0/docs/general/recording-errors.md
[otel-os]: https://github.com/open-telemetry/semantic-conventions/blob/v1.44.0/docs/resource/os.md
[otel-host]: https://github.com/open-telemetry/semantic-conventions/blob/v1.44.0/docs/resource/host.md
[otel-session]: https://github.com/open-telemetry/semantic-conventions/blob/v1.44.0/docs/general/session.md
[otel-user]: https://github.com/open-telemetry/semantic-conventions/blob/v1.44.0/docs/registry/attributes/user.md
[otel-http]: https://github.com/open-telemetry/semantic-conventions/blob/v1.44.0/docs/registry/attributes/http.md
[genai-root]: https://github.com/open-telemetry/semantic-conventions-genai/blob/b5d8440f6f126738fd50f927752cd669772c517b/docs/gen-ai/README.md
[genai-agents]: https://github.com/open-telemetry/semantic-conventions-genai/blob/b5d8440f6f126738fd50f927752cd669772c517b/docs/gen-ai/gen-ai-agent-spans.md
[genai-spans]: https://github.com/open-telemetry/semantic-conventions-genai/blob/b5d8440f6f126738fd50f927752cd669772c517b/docs/gen-ai/gen-ai-spans.md
[genai-input-schema]: https://github.com/open-telemetry/semantic-conventions-genai/blob/b5d8440f6f126738fd50f927752cd669772c517b/model/gen-ai/gen-ai-input-messages.json
[genai-output-schema]: https://github.com/open-telemetry/semantic-conventions-genai/blob/b5d8440f6f126738fd50f927752cd669772c517b/model/gen-ai/gen-ai-output-messages.json
[genai-tools-schema]: https://github.com/open-telemetry/semantic-conventions-genai/blob/b5d8440f6f126738fd50f927752cd669772c517b/model/gen-ai/gen-ai-tool-definitions.json
[genai-tool-args-schema]: https://github.com/open-telemetry/semantic-conventions-genai/blob/b5d8440f6f126738fd50f927752cd669772c517b/model/gen-ai/gen-ai-tool-call-arguments.json
[genai-tool-result-schema]: https://github.com/open-telemetry/semantic-conventions-genai/blob/b5d8440f6f126738fd50f927752cd669772c517b/model/gen-ai/gen-ai-tool-call-result.json
