# Trace Schema

本文档定义 OpenCode v1 trace 监控插件通过 OTLP 导出的 trace 结构、span attributes 及字段口径。字段优先采用 OpenTelemetry（OTel）和 GenAI Semantic Conventions；标准未覆盖的 OpenCode 业务信息使用 `opencode.*` 扩展。新 schema 不再导出 OpenInference 属性。

默认 span 名称前缀为 `opencode.`；设置 `OPENCODE_TRACE_PREFIX` 后替换此前缀。本文保留 `run`、`interaction`、`llm` 等 OpenCode 专用 span 名称，通过 `gen_ai.operation.name` 表达标准操作语义。这是 GenAI 规范允许的框架专用命名约定；前缀只影响 span 名称，不影响 attribute key 或 operation 值。

## 1. Schema 约定

### 1.1 规范基线

- 通用字段依据 [OTel Semantic Conventions v1.44.0][otel-semconv]。
- GenAI 字段和消息结构依据独立的 [GenAI Semantic Conventions 仓库][genai-root]，本次固定到提交 `b5d8440f6f126738fd50f927752cd669772c517b`。GenAI 仍处于 Development，升级基线时需重新检查字段、单位和 JSON Schema，不能自动跟随 `main`。
- 本文描述的必填条件是插件契约；标准的 `Required`、`Recommended`、`Opt-In` 等要求应结合具体 span 类型理解。普通 OTel span 不因携带会话关联字段而成为 GenAI inference span。
- OTLP 负责传输；业务属性使用下文的点分命名。`trace_id`、`span_id`、`parent_span_id`、开始/结束时间、`kind`、`status`、events 属于 span envelope，resource 和 instrumentation scope 属于其外层上下文，均不重复导出为 span attributes。

### 1.2 类型、内容采集与缺省值

- `必有`：span 创建时或正常结束时一定写入；`条件`：仅在指定数据或关联存在时写入；`初始值`：创建时写入，结束前可能更新。
- `int` 表示整数计数，`double` 表示浮点值；两者在 JavaScript 中均为 `number`。`string[]` 是原生 OTel 字符串数组，不序列化为 JSON 字符串。
- `string(JSON)` 表示序列化一次的 JSON 值。GenAI 将消息、工具定义及调用参数/结果定义为结构化 `any`，支持结构化 span attributes 时优先使用结构化值；本插件 v1 的 JS SDK 导出约定使用规范允许的 JSON 字符串形式。不能笼统认为 OTLP 不支持嵌套对象，也不能把 JSON 字符串再次编码。本文 JSON 示例展示序列化前的值。
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

常见归一化规则：`process.platform` 的 `win32 → windows`、`sunos → solaris`，`linux` / `darwin` 等保持原值；架构的 `x64 → amd64`、`ia32 → x86`、`arm → arm32`、`arm64 → arm64`。`process.arch` 表示当前进程架构，仅当确认可代表主机架构时用作 `host.arch` 来源；无法确认时省略，不把仿真进程架构当作主机架构。[OS 字段][otel-os]、[Host 字段][otel-host]

启用遥测时，插件通过 OpenCode client 的请求通道查询一次 `/global/health`，将响应中的非空 `version` 写入 `service.version`。查询超时（1 秒）、失败或版本缺失时省略该字段，不影响后续采集。自定义 resource 属性仍可覆盖 `service.name` 和 `service.version`。

Instrumentation scope：

| 字段    | 值                  |
| ------- | ------------------- |
| name    | `opencode-observer` |
| version | 当前插件包版本      |

Scope 的名称和版本均读取插件 `package.json`，随构建嵌入产物。

本插件混合使用 OTel、GenAI 和 OpenCode 扩展，不能仅以核心 OTel schema URL 声称所有扩展都有自动迁移规则；GenAI 提交号也不是一个已发布的 schema URL。

### 2.2 公共 attributes

| 字段                         | 类型   | 出现条件               | 说明                                                                                                                        |
| ---------------------------- | ------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `session.id`                 | string | 所有 span 必有         | OpenCode session ID；也是 OTel 标准会话关联字段。                                                                           |
| `gen_ai.conversation.id`     | string | 所有 span 必有         | 与 `session.id` 相同，用于 GenAI 会话关联。                                                                                 |
| `opencode.session.parent_id` | string | 父 session 可识别时    | subagent 的父 session ID。不能改为表示“前一个会话”的 `session.previous_id`。                                                |
| `user.id`                    | string | 已发起查询或配置身份时 | 来自初始化时的 `spanAttributes`，静态配置优先于查询结果；查询失败且没有静态身份时为 `unknown`，未查询且没有静态身份时省略。 |
| `<custom-span-attribute>`    | string | 配置存在时             | 来自 `OPENCODE_SPAN_ATTRIBUTES`；除 `user.id` 外，不能覆盖插件维护的身份、类型、标准操作值或其他派生字段。                  |

子 agent 的所有 span 使用自己的 `session.id` 和 `gen_ai.conversation.id`，父 session ID 只记录在 `opencode.session.parent_id`。[Session 字段][otel-session]、[User 字段][otel-user]

`user.id` 由插件入口在初始化阶段直接调用独立 user 模块解析，使用 `OPENCODE_USER_ID_TOKEN` 调用 `OPENCODE_USER_ID_ENDPOINT`，从成功响应的 `result.ssicNo` 取得 ID；接口返回空值或 `unknown` 时视为未取得有效身份。入口等待查询和重试完成后，将有效 ID 合并进 `spanAttributes`；静态配置的 `user.id` 始终优先于查询结果。没有静态配置时，查询最终失败使用 `unknown` 兜底，因开关关闭、地址无效或 token 为空而跳过查询则省略。六类 span 从创建起统一使用此配置快照，tracker 和观测契约不传递用户身份。正文采集开关不控制该属性，身份不会自动刷新或写入 resource。模型请求头中的动态身份传播由 adapter 单独完成，规则见第 3.3 节。配置与重试规则见 [README](../../README.md#用户身份解析)。

默认每个 span 最多保留 4096 个 attributes，可通过 `OPENCODE_SPAN_ATTRIBUTE_COUNT_LIMIT` 调整。超过限制时由 OTel SDK 丢弃多余字段；此数量上限不代表单个属性值或整个 OTLP 请求可以无限大。

## 3. Trace 拓扑

### 3.1 主会话

```text
opencode.run                         invoke_workflow / INTERNAL
└── opencode.interaction             invoke_agent / INTERNAL
    ├── opencode.llm                 chat 等实际操作 / CLIENT
    ├── opencode.tool.<tool-name>    execute_tool / INTERNAL
    │   └── opencode.permission.check             INTERNAL
    └── opencode.compaction                       INTERNAL
        └── opencode.llm             chat 等实际操作 / CLIENT
```

- 一个 `run` 对应 session 中一个任务的执行周期，一个 `interaction` 对应任务中的一次真实用户交互。
- 同一个 run 可以包含多个 interaction。用户通过 steer 输入新的消息时，创建新 interaction，run 保持打开。
- steer 到来时，旧 interaction 正常结束，status 保持 `UNSET`，结束时间等于新 interaction 的开始时间；正文开启时输出为空消息数组 `[]`，不保留中途生成的文本。
- interaction 以 owner 用户消息 ID 为稳定标识，可包含多次 LLM 请求、工具调用和自动压缩。
- LLM span 和 tool span 直接挂在拥有它们的 interaction 下；tool span 不是 LLM span 的子节点。
- permission span 只在人工权限请求可以精确关联到活动 tool 时创建，挂在对应 tool 下。
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

所有 span 均包含第 2.2 节的公共属性。下文属性表只列各 span 的额外字段；公共错误规则见第 11 节。

| Span 名称                  | OTel kind  | `gen_ai.operation.name`                                  | 常规 parent                           | 创建数量                                                            |
| -------------------------- | ---------- | -------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `<prefix>run`              | `INTERNAL` | `invoke_workflow`                                        | 无（顶层）或父 `task` tool            | session 中每个任务执行周期 1 个                                     |
| `<prefix>interaction`      | `INTERNAL` | `invoke_agent`                                           | 当前 session 的 run                   | 每次真实用户交互 1 个                                               |
| `<prefix>compaction`       | `INTERNAL` | 不设置                                                   | interaction                           | 每次压缩 1 个                                                       |
| `<prefix>llm`              | `CLIENT`   | `chat`、`generate_content`、`text_completion` 等实际操作 | interaction、compaction               | 每条有请求准备或模型 step 证据的 assistant message 1 个，覆盖其重试 |
| `<prefix>tool.<tool-name>` | `INTERNAL` | `execute_tool`                                           | 所属 assistant message 的 interaction | 每次 tool call 1 个                                                 |
| `<prefix>permission.check` | `INTERNAL` | 不设置                                                   | 精确关联的活动 tool span              | 每次可关联的人工权限检查 1 个                                       |

`gen_ai.operation.name` 不是 OTel `SpanKind` 的替代品。run 表示工作流执行，interaction 表示本地 agent 调用；compaction 和 permission 是普通 OTel 内部操作，本基线没有可直接对应它们的 GenAI 标准操作值，不伪造 `CHAIN`、`GUARDRAIL` 或新的标准操作值。[Agent / workflow span 规范][genai-agents]、[模型 / tool span 规范][genai-spans]

## 5. `<prefix>run`

### 5.1 Attributes

| 字段                     | 类型         | 出现条件     | 值与口径                                                                           |
| ------------------------ | ------------ | ------------ | ---------------------------------------------------------------------------------- |
| `gen_ai.operation.name`  | string       | 必有         | `invoke_workflow`。                                                                |
| `opencode.run.id`        | string       | 必有         | 本次任务执行的首个真实用户消息 ID；不是 provider response ID。                     |
| `gen_ai.input.messages`  | string(JSON) | 必有         | 按 interaction 顺序记录工作流收到的用户消息，采用第 8.2 节的 `role + parts` 结构。 |
| `gen_ai.output.messages` | string(JSON) | 任务正常结束 | 最后一个 interaction 的最终答复消息数组。                                          |

run 的 `gen_ai.input.messages` 示例：

```json
[
  { "role": "user", "parts": [{ "type": "text", "content": "检查构建失败原因" }] },
  { "role": "user", "parts": [{ "type": "text", "content": "先检查依赖版本" }] }
]
```

这里记录工作流层面的输入，LLM span 上的同名字段记录实际模型请求内容，两者观察范围不同。

run 和 interaction 只聚合真实用户文本及最终 assistant 文本，过滤 synthetic / ignored 文本和压缩摘要。只有附件而没有可用文本的用户输入不伪造空文本：对应 interaction 省略输入属性，包含此类输入的 run 省略整个 `gen_ai.input.messages`，避免将不完整输入表示为完整任务。未知或未完成的输出省略，明确观察到的空文本输出保留。

### 5.2 生命周期

- 开始时间为本次任务首个用户消息的创建时间。
- 正常结束以 `session.status` 的 `status.type=idle` 判断，兼容已弃用的 `session.idle`；两者可能连续到达，必须去重结束。status 保持 `UNSET`。
- 终止性 `session.error` 或无法恢复的 context overflow 导致 `ERROR` 结束，记录 `error.type` 和 status message。

## 6. `<prefix>interaction`

### 6.1 Attributes

| 字段                      | 类型         | 出现条件                  | 值与口径                                                           |
| ------------------------- | ------------ | ------------------------- | ------------------------------------------------------------------ |
| `gen_ai.operation.name`   | string       | 必有                      | `invoke_agent`。                                                   |
| `opencode.interaction.id` | string       | 必有                      | owner 用户消息 ID。                                                |
| `gen_ai.agent.name`       | string       | 必有                      | 用户消息指定的 agent 名称。                                        |
| `opencode.agent.type`     | string       | 必有                      | `primary` 或 `subagent`。                                          |
| `gen_ai.input.messages`   | string(JSON) | 必有                      | 单条 `role=user` 消息；拼接后的用户文本放在 `parts[].content` 中。 |
| `gen_ai.output.messages`  | string(JSON) | 正常结束，包括 steer 结束 | 正常答复为最终 assistant 消息；steer 结束时为 `[]`。               |

实际生成了空文本答复时可以记录 `[{"role":"assistant","parts":[{"type":"text","content":""}]}]`；steer 的 `[]` 表示这次交互没有最终答复。正文关闭或数据未知时省略属性，不能用 `[]` 表示“未采集”。

### 6.2 生命周期

- 开始时间为 owner 用户消息的 `time.created`。synthetic 自动续接消息和 compaction marker 用户消息不会创建 interaction；v1 的 `synthetic` 位于 text part 上，不能读取不存在的 message 级字段。含真实用户输入的混合消息仍创建 interaction。
- 收到同一 run 的新 steer 用户消息时，旧 interaction 正常结束，结束时间严格等于新 interaction 的开始时间，status 保持 `UNSET`；正文开启时写入 `gen_ai.output.messages=[]`。
- 未被 steer 结束的 interaction 在 session idle 时结束，结束时间使用插件观察到 idle 的时间，与所属 run 一致。
- 对应用户消息最后一次非摘要 assistant 的 `time.completed` 仅用于判断回复是否完成，不作为 span 结束时间。若缺少该字段，或只有 `tool-calls` 而未取得最终答复，则以 `ERROR` 清理，`error.type=_OTHER`，status message 为 `session ended before interaction completed`；不回退到更早 assistant 的答复。已确认完成但未采集正文时仍可正常结束，省略输出属性。
- 旧 interaction 结束后不再回填输出或修改结束时间。已归属旧 interaction 的 LLM/tool span 保持原 parent，即使其完成事件晚于 steer 到达，也不改挂到新 interaction。
- 发生终止错误时以 `ERROR` 结束。可恢复的 context overflow 期间保持打开。

## 7. `<prefix>compaction`

### 7.1 Attributes

| 字段                                     | 类型    | 出现条件                  | 值与口径                                                                       |
| ---------------------------------------- | ------- | ------------------------- | ------------------------------------------------------------------------------ |
| `opencode.compaction.id`                 | string  | 必有                      | compaction marker 用户消息 ID。                                                |
| `opencode.compaction.auto`               | boolean | 必有                      | 是否为自动压缩。                                                               |
| `opencode.compaction.overflow`           | boolean | 必有                      | compaction part 的 `overflow === true`；源字段缺省时为 `false`。               |
| `opencode.compaction.trigger_message.id` | string  | overflow 触发且消息可识别 | 发生 overflow 的 assistant message ID。                                        |
| `opencode.compaction.prompt_tokens`      | int     | 压缩成功且摘要 usage 可用 | 摘要 assistant 的 `tokens.input + tokens.cache.read + tokens.cache.write`。    |
| `opencode.compaction.summary_tokens`     | int     | 压缩成功且摘要 usage 可用 | 摘要 assistant 的 `tokens.output`，保留“不包含 reasoning”的原业务口径。        |
| `gen_ai.usage.*`                         | int     | 压缩成功且摘要 usage 可用 | 镜像摘要 LLM 的归一化 input / output、reasoning 与 cache 分量，口径见第 8 节。 |

compaction 上的标准 usage 是子摘要 LLM 用量的镜像。

### 7.2 生命周期

- 开始时间优先使用 compaction marker 用户消息创建时间，否则使用当前观察时间。
- 收到 `session.compacted` 时正常结束，status 保持 `UNSET`。该事件只有 `sessionID`，不携带 compaction ID 或 token usage，需与该 session 的活动 compaction 和摘要 assistant 关联。
- 压缩期间又出现 context overflow、被新的压缩覆盖、会话终止或摘要 assistant 出错时，以 `ERROR` 结束。
- 摘要 LLM span 携带相同 `opencode.compaction.id`，并以 compaction span 为 parent。

## 8. `<prefix>llm`

### 8.1 身份、模型和用量

| 字段                                                  | 类型     | 出现条件                           | 值与口径                                                                                                                                                                   |
| ----------------------------------------------------- | -------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen_ai.operation.name`                               | string   | 必有                               | 按实际模型 API 操作设置：聊天补全为 `chat`，内容生成为 `generate_content`，传统文本补全为 `text_completion`。遵循对应 provider 的约定，不因 span 名为 `llm` 就写入 `llm`。 |
| `gen_ai.provider.name`                                | string   | 必有                               | 插件识别的 provider 标准名；例如 `openai`、`anthropic`、`aws.bedrock`、`azure.ai.openai`、`gcp.gemini`、`gcp.vertex_ai`。                                                  |
| `opencode.provider.id`                                | string   | 必有                               | OpenCode 原始 provider ID，用于保留配置身份。                                                                                                                              |
| `gen_ai.request.model`                                | string   | 必有                               | 请求的 model ID。                                                                                                                                                          |
| `gen_ai.response.model`                               | string   | 实际响应提供时                     | 响应中确认的模型名，不能用请求 model ID 补造。                                                                                                                             |
| `gen_ai.response.id`                                  | string   | 实际响应提供时                     | Provider response ID，不能用 OpenCode assistant message ID 替代。                                                                                                          |
| `opencode.message.id`                                 | string   | 必有                               | OpenCode assistant message ID。                                                                                                                                            |
| `gen_ai.agent.name`                                   | string   | agent 可识别时                     | 优先使用 assistant 的 `agent`，兼容 `mode`；未知时省略。                                                                                                                   |
| `opencode.agent.type`                                 | string   | 必有                               | `primary` 或 `subagent`。                                                                                                                                                  |
| `gen_ai.usage.input_tokens`                           | int      | 模型请求成功且 usage 可用          | OpenCode 归一化后的 `tokens.input + tokens.cache.read + tokens.cache.write`，包含缓存输入。                                                                                |
| `gen_ai.usage.output_tokens`                          | int      | 模型请求成功且 usage 可用          | OpenCode 归一化后的 `tokens.output + tokens.reasoning`，包含 reasoning。                                                                                                   |
| `gen_ai.usage.reasoning.output_tokens`                | int      | 模型请求成功且对应 usage 可用      | `tokens.reasoning`，是 output tokens 的子集。                                                                                                                              |
| `gen_ai.usage.cache_read.input_tokens`                | int      | 模型请求成功且对应 usage 可用      | `tokens.cache.read`，是 input tokens 的子集。                                                                                                                              |
| `gen_ai.usage.cache_write.input_tokens`               | int      | 模型请求成功且对应 usage 可用      | `tokens.cache.write`，是 input tokens 的子集；本基线使用 `cache_write`。                                                                                                   |
| `opencode.llm.cost.total`                             | double   | 模型请求成功且 cost 可用           | OpenCode assistant 的 `cost`，单位 USD。通常为计价估算；缺少价格时源数据可能为 `0`，不代表账单实付金额。                                                                   |
| `gen_ai.response.finish_reasons`                      | string[] | 存在结束原因，或生成异常终止       | 单候选时为 `[assistant.finish]`；缺失预期的结束原因且生成失败、取消或流异常结束时，对应位置写入 `error`。                                                                  |
| `gen_ai.response.time_to_first_chunk`                 | double   | 实际探测到请求发起和首 chunk       | 秒。当前逻辑模型请求发起到首次收到响应流 chunk 的时间；不要求 chunk 含非空文本。计时起点不随重试重置，包含首 chunk 前的重试和退避。                                        |
| `opencode.llm.successful_attempt.time_to_first_chunk` | double   | 请求最终成功且可精确测量该 attempt | 秒。最终成功 attempt 开始到该 attempt 首 chunk 的时间，保留原文档的 attempt 级指标；与上一行的逻辑请求口径不同。                                                           |

usage 公式适用于 OpenCode 已归一化的 token 数据；如果另取 provider 原始 usage，需先理解其缓存和 reasoning 是否已经包含在总量中，不能再次相加。本文基线没有通用的 `gen_ai.usage.total_tokens` 或费用属性；总 token 数直接由 input + output 计算，不另造标准字段。LLM span 覆盖重试，但源 assistant usage/cost 不保证包含所有失败 attempt 的消耗，不将其描述为完整重试账单。

`gen_ai.response.finish_reasons` 按返回候选顺序排列，不能把各次 retry 的 finish reason 混入这个数组。正文数组经过过滤时，finish reasons 仍对应原候选顺序。不再把 `finish_reason` 写到输出消息对象中，该 JSON 属性在本基线已弃用。

### 8.2 消息与系统指令

| 字段                         | 类型         | 出现条件                           | 值与口径                                                                                                    |
| ---------------------------- | ------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `gen_ai.input.messages`      | string(JSON) | 正文开启且取得输入内容             | 使用 GenAI InputMessages 结构；实际请求消息按发送顺序记录。                                                 |
| `gen_ai.output.messages`     | string(JSON) | 正文开启且取得输出内容或确认空输出 | 使用 GenAI OutputMessages 结构；每个元素代表一个输出候选，该候选的多个内容片段放在同一 `parts` 数组。       |
| `gen_ai.system_instructions` | string(JSON) | 正文开启且取得单独传入的系统指令   | 使用 SystemInstructions 的 part 数组；如果系统指令本来位于聊天历史中，则保留在 input messages，不重复拆出。 |

消息必须遵循官方 [InputMessages][genai-input-schema] / [OutputMessages][genai-output-schema] JSON Schema。下面是纯文本输入示例；实际内容可含更多已定义的 part 类型：

```json
[{ "role": "user", "parts": [{ "type": "text", "content": "读取项目配置" }] }]
```

模型请求工具时的输出示例：

```json
[
  {
    "role": "assistant",
    "parts": [
      { "type": "text", "content": "我会先读取配置。" },
      {
        "type": "tool_call",
        "id": "call_read_config",
        "name": "read",
        "arguments": { "filePath": "package.json" }
      }
    ]
  }
]
```

后续模型请求中的工具结果消息示例：

```json
[
  {
    "role": "tool",
    "parts": [
      { "type": "tool_call_response", "id": "call_read_config", "response": "配置文件内容" }
    ]
  }
]
```

单独传入的 `gen_ai.system_instructions` 示例：

```json
[{ "type": "text", "content": "根据当前项目上下文回答用户问题。" }]
```

转换和降级规则：

- 当前实现从 AI SDK `onStepStart` 采集 SDK 可见的请求消息与独立 system，从 `onStepFinish.content` 采集当前 step 的生成内容；只在后者不可用时取 `response.messages` 的最后一个 assistant。输出不包含历史 step 或本地工具执行结果。采集通道和关联约束见 [适配层设计 §3](../adapter.md#3-llm-关联与采集)。
- OpenAI 风格的 `content` / `tool_calls` 要转换为 GenAI `parts`；不能只改外层 attribute key。工具调用的 `arguments` 尽量解析为结构化 JSON，并保持 call ID 与工具 span、工具结果消息一致。
- 保留文本、tool call、tool response 等已采集片段的顺序；多模态内容按相应 part schema 处理。文本的类型由 `type=text` 表达，不再导出通用的 input/output MIME attributes。
- reasoning 使用 `reasoning` part；媒体 URL 使用 `uri`，二进制和 data URI 使用 base64 `blob`。不下载媒体内容，不将未知片段或整个 SDK 对象作为正文透传。
- 未取得完整 AI SDK lifecycle 数据时，输入 fallback 只记录 owner 用户消息文本，输出 fallback 只记录可观察到的 assistant 文本，二者仍转换为相同 GenAI 消息结构。此时不表示取得了完整系统提示词、历史上下文或原始响应。
- 不在 LLM span 创建时预填空输出数组；尚未观察到输出应省略。已知没有返回候选时可以记录 `[]`，实际空文本候选可以记录一个内容为空的 text part。

### 8.3 请求参数、工具定义和 HTTP 属性

原先聚合在 invocation JSON 中、有标准对应项的参数拆成独立 attributes。只写入实际取得的有效值，不把未配置参数的假定默认值当作实测值。

`gen_ai.output.type` 独立于正文采集开关。工具定义和模型请求／响应 headers 与输入输出正文共用 `captureContent`，默认关闭，不提供额外开关。`gen_ai.request.seed` 不采集。

| 字段                         | 类型         | 来源                                                                                             |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `gen_ai.request.max_tokens`  | int          | 取得 `maxOutputTokens`。                                                                         |
| `gen_ai.request.temperature` | double       | 取得 `temperature`。                                                                             |
| `gen_ai.request.top_p`       | double       | 取得 `topP`。                                                                                    |
| `gen_ai.request.top_k`       | int          | 取得 `topK`。                                                                                    |
| `gen_ai.request.stream`      | boolean      | 确认本次请求是否使用流式响应。                                                                   |
| `gen_ai.output.type`         | string       | 取得 AI SDK 显式 `output.responseFormat.type`，当前支持 `text`、`json`；未指定或无法识别时省略。 |
| `gen_ai.tool.definitions`    | string(JSON) | `captureContent=true` 时，取得当前 SDK step 经 `activeTools` 筛选的工具定义。                    |
| `http.request.header.<key>`  | string[]     | `captureContent=true` 时取得的 SDK step 请求 headers；key 为小写 header 名。                     |
| `http.response.header.<key>` | string[]     | `captureContent=true` 时取得的 SDK 响应或可关联 API 错误的响应 headers；key 为小写 header 名。   |

`gen_ai.tool.definitions` 使用 [ToolDefinitions JSON Schema][genai-tools-schema]，替代逐项展开的工具属性。函数工具直接使用顶层 `type=function` / `name`，不能保留 OpenAI 的外层 `function` 包装；开启 `captureContent` 后一并记录可取得的 `description` 和 `parameters`。参数定义使用 AI SDK 的 Schema 转换结果，采用 JSON Schema draft-07；转换失败时保留工具身份并省略参数，不影响其他工具。provider 工具使用 SDK 的 provider tool ID 作为 `type`，保留调用名称 `name`，不伪装成函数工具。已知有效工具集合为空时记录 `[]`，没有工具快照时省略。例如：

```json
[
  {
    "type": "function",
    "name": "read",
    "parameters": {
      "type": "object",
      "properties": { "filePath": { "type": "string" } },
      "required": ["filePath"]
    }
  }
]
```

HTTP header 示例是原生 attribute 值：`http.request.header.content-type=["application/json"]`。即使只有一个值也必须是 `string[]`，保留 header 名中的连字符；多值按 HTTP 库提供的形式记录，不能任意按逗号拆分。[HTTP 字段规范][otel-http]

请求 headers 反映 SDK 可见值，不补造 provider 或底层 HTTP 库稍后追加的 headers；响应 headers 不要求成功状态，但必须能关联到对应 LLM。内部关联标识 `x-opencode-observer-request` 不采集。模型 headers 与 `otlpHeaders` 配置的 collector 导出 headers 相互独立。

这些字段使用当前 step 的快照；新请求清理旧工具定义、输出类型和响应 headers。不能取得 SDK 回调（例如 native 路径）时省略相应字段，不根据工具执行记录、回答文本或其他请求推测。异步解析、快照提交及迟到结果处理见 [适配层设计 §3.3](../adapter.md#33-数据转换与快照提交)。

### 8.4 Retry attributes

| 字段                         | 类型         | 出现条件        | 值与口径                                                                               |
| ---------------------------- | ------------ | --------------- | -------------------------------------------------------------------------------------- |
| `opencode.llm.retry_count`   | int          | 必有，初始 `0`  | 已观察到 OpenCode 从 retry 重新进入 busy 的次数，不含初次执行，等于 history 的记录数。 |
| `opencode.llm.retry_history` | string(JSON) | 必有，初始 `[]` | 按 attempt 升序排列的已确认 OpenCode 重试记录，不包含仍在退避的计划。                  |

`opencode.llm.retry_history` 的结构：

```ts
type RetryHistory = Array<{
  attempt: number;
  reason: string;
  scheduled_start_offset_ms?: number;
  observed_start_offset_ms: number;
}>;
```

采集范围为 **OpenCode session processor 的重试流程**，不统计 AI SDK、鉴权插件、provider 或传输层内部的请求重发，也不要求探测网络请求边界。`session.status` 的 retry 通知携带 `attempt`、`message` 和预计重试时间 `next`，在退避前发送。适配层将通知绑定到同一 run 下唯一可识别的活动 assistant；随后观察到该调用对应 session 的 busy，确认 OpenCode 已重新进入执行流程，增加计数并写入 history。摘要调用采用相同规则；归属未知或歧义时省略该次记录，不根据其他 session 或新 assistant 的活动补计。

`attempt` 保留 OpenCode 通知的正整数序号，`reason` 取通知的 `message`。重复或较旧序号不重复记录；busy 没有待执行通知时不计数。退避期间取消、终止、删除或关闭不会提交该条计划，已确认历史保留。缺失中间 busy 时不按最大 attempt 补造次数，因此 count 可能小于最大的 attempt。`0` / `[]` 表示没有观察并确认到 OpenCode 重试，不保证底层没有重发。

两个时间字段均为相对 LLM span 开始时间（`assistant.time.created`）的毫秒偏移，不受 `captureContent` 控制：

- `scheduled_start_offset_ms` = retry 通知的 `next` − span 开始时间。表示预计恢复执行时间；无效 `next` 时省略。
- `observed_start_offset_ms` = 插件接收到后续 busy 的本地时间 − span 开始时间。表示 OpenCode 恢复执行的观察时间，不能用作实际网络请求发出时间。旧的 `start_offset_ms` 不再导出。

两者之差可用于观察计划与恢复执行通知的偏差，但包含调度和事件分发延迟，不是精确的定时器误差。OpenCode 以当前时间加退避时长计算 `next`；事件循环繁忙、GC、进程或系统暂停都可能延迟恢复，之后的请求准备、其他插件 hooks、鉴权和连接建立还会推迟网络请求。没有固定的毫秒级误差保证或上限；取消时甚至不会实际执行。系统时钟调整可能令差值为负，保留原始差值，不钳制为零。这些字段不能替代首 chunk 耗时或 `http.request.resend_count`。

### 8.5 生命周期与状态

- 仅为有请求准备或模型 step 证据的 assistant message 创建 span。OpenCode 的 subtask / 命令路径也可能直接构造 assistant message，不能仅凭 `role=assistant` 创建 LLM span。
- 开始时间统一使用 `assistant.time.created`，正常结束时间统一使用 `assistant.time.completed`。这是 assistant 消息生命周期，包含请求准备、重试退避、工具执行和清理，不表示纯模型或网络请求耗时。
- 当前实现优先在 `chat.headers` 唯一匹配 assistant 和 parent 后创建 span，以便发送前传播上下文；未取得该关联时，等待 `step-start` 和消息归属证据。实际创建时间可以晚于开始时间，但起点始终取消息的 `time.created`，不使用 hook 或事件接收时间替代。缺失或无效的创建时间不补造 span；只有完成消息或结束事件、没有请求准备或 step 开始证据时也不创建 span。
- `step-finish` 提供结束原因、用量和费用，不提供 span 结束时间。消息完成与 step 结果乱序时分别暂存；成功结果仍等待已绑定的 SDK 输出，提交结束时保持消息时间。结束时间必须有效且不早于创建时间，重复通知和迟到更新不得改写已结束 span。
- 无法测量首 chunk 时，不导出标准或 attempt 级首 chunk 耗时。不能用首个 assistant 文本事件的观察时间伪造精确值。
- 正常完成保持 `UNSET`，provider / OpenCode 错误终止时设置 `ERROR`、`error.type` 和 status message。重试后成功的逻辑 LLM span 不残留终态 `error.type` 或 `ERROR`；重试原因保留在 history。
- session 或插件收尾时，已取得消息完成时间但仍等待 SDK 输出或 step 结果的调用，保留该完成时间和已知结果，省略缺失内容及用量；不因采集回调缺失而把已完成调用标为失败。仍未取得消息完成时间的调用以 `ERROR` 清理，status message 为 `session ended before message completed` 或具体终止原因。

异常边界：

| 场景                                           | 时间与状态                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 错误或取消的 assistant 更新已包含 completed    | 使用消息创建、完成时间，保留具体错误。                                                   |
| session.error 先于 completed 到达              | 立即按错误观察时间收尾并标记 `observation`；不延迟宿主，也不等待可能永不到达的完成更新。 |
| step-finish 已到达，但 idle 时仍没有 completed | 使用 idle 观察时间，以消息未完成错误收尾；不能把 step 完成当作消息完成。                 |
| 已有 completed，SDK 输出或 step 结果未到达     | 收尾时保留消息完成时间；只保留已有的数据，不填入初始化零用量。                           |
| 消息删除、压缩结束或插件关闭                   | 优先保留已有消息完成时间；缺失时按对应终止观察时间和错误收尾。                           |
| 重试后成功                                     | 同一 assistant 仍只有一个 span，从消息创建到完成；包含退避，不残留终态错误。             |
| 可恢复的上下文溢出                             | 失败的 LLM 调用独立结束，run / interaction 可继续执行压缩和后续调用。                    |
| 进程被强杀或崩溃，未执行 dispose               | 不保证活动 span 能结束或导出，不补造完成时间。                                           |

## 9. `<prefix>tool.<tool-name>`

### 9.1 Attributes

| 字段                         | 类型         | 出现条件                 | 值与口径                                                        |
| ---------------------------- | ------------ | ------------------------ | --------------------------------------------------------------- |
| `gen_ai.operation.name`      | string       | 必有                     | `execute_tool`。                                                |
| `gen_ai.tool.call.id`        | string       | 必有                     | tool part 的 `callID`，不是 part 的 `id`。                      |
| `gen_ai.tool.name`           | string       | 必有                     | tool part 的 `tool`，同时参与 span 名称。                       |
| `gen_ai.tool.call.arguments` | string(JSON) | 正文开启且参数可用       | tool part 的 `state.input` 对象。                               |
| `gen_ai.tool.call.result`    | string(JSON) | 正文开启且 tool 成功完成 | `state.output` 经下述规则转换后的结果对象；失败时不填写此属性。 |
| `gen_ai.agent.name`          | string       | 所属 agent 可识别时      | 所属 assistant 的 `agent`，兼容 `mode`；未知时省略。            |
| `opencode.agent.type`        | string       | 完成后的 span 必有       | `primary` 或 `subagent`。                                       |

参数和结果分别遵循 [ToolCallArguments][genai-tool-args-schema] / [ToolCallResult][genai-tool-result-schema] JSON Schema。本基线要求对象：`state.output` 若可解析为 JSON 对象，则使用该对象；否则使用插件定义的 `{ "content": state.output }` 包装，保留原始文本。`content` 是本插件结果对象的约定，并非新增的 GenAI attribute。

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

## 10. `<prefix>permission.check`

### 10.1 Attributes

| 字段                           | 类型     | 出现条件       | 值与口径                                                     |
| ------------------------------ | -------- | -------------- | ------------------------------------------------------------ |
| `gen_ai.agent.name`            | string   | agent 可识别时 | 关联工具所属 assistant 的 `agent`，兼容 `mode`；未知时省略。 |
| `opencode.agent.type`          | string   | 必有           | `primary` 或 `subagent`。                                    |
| `gen_ai.tool.call.id`          | string   | 必有           | 被检查的工具调用 ID，与父 tool span 相同。                   |
| `gen_ai.tool.name`             | string   | 必有           | 从对应 tool part 的 `tool` 取得，与父 tool span 相同。       |
| `opencode.permission.name`     | string   | 必有           | 权限类型。                                                   |
| `opencode.permission.patterns` | string[] | 必有           | 请求匹配的 patterns。                                        |
| `opencode.permission.reply`    | string   | 收到 reply     | `once`、`always` 或 `reject`。                               |
| `opencode.permission.granted`  | boolean  | 收到 reply     | reply 不为 `reject` 时为 `true`。                            |

此 span 的 GenAI tool 字段仅引用被检查的工具调用，不表示又执行了一次工具，因此不设置 `gen_ai.operation.name=execute_tool`。权限模式、人工决策和 patterns 没有等价的标准 GenAI 字段，保留 OpenCode 扩展。

### 10.2 生命周期与状态

- 开始/结束时间使用本地 `Date.now()`，测量插件观察到的权限等待时间。
- `permission.asked` 的 `id` 与 `permission.replied` 的 `requestID` 配对。asked 中的 `tool` 可选，且只有 `messageID` / `callID`，不包含工具名称；必须精确关联活动 tool 后才创建 permission span。
- 收到任何 reply 都表示检查流程正常结束，status 保持 `UNSET`。`reject` 通过 `opencode.permission.granted=false` 表达；随后关联 tool 若因该拒绝而失败，使用 `error.type=PermissionRejectedError`。
- tool 或 session 在 reply 前结束，或 pending map 淘汰该请求时，permission span 以 `ERROR` 清理。

## 11. 状态与错误汇总

| Span             | 正常结束 status | 常见 ERROR 条件                                  |
| ---------------- | --------------- | ------------------------------------------------ |
| run              | `UNSET`         | 终止 session error、overflow 恢复失败            |
| interaction      | `UNSET`         | 所属 session / assistant 终止错误                |
| compaction       | `UNSET`         | 摘要错误、被新压缩覆盖、session 提前结束         |
| llm              | `UNSET`         | 模型调用最终失败、session 提前结束               |
| tool             | `UNSET`         | tool error、session 提前结束                     |
| permission.check | `UNSET`         | tool / session 在 reply 前结束、pending map 淘汰 |

所有 span 共用以下错误规则：

| 字段 / 位置                       | 类型   | 出现条件                 | 口径                                                                                                             |
| --------------------------------- | ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `error.type`（span attribute）    | string | `ERROR` 结束时必有       | 优先用源错误类型或稳定错误码；无法识别且未定义具体分类时用 OTel `_OTHER`。不把完整错误文本当作类型。             |
| `status.code`（span envelope）    | enum   | 所有 span                | 正常保持 `UNSET`，失败为 `ERROR`。                                                                               |
| `status.message`（span envelope） | string | `ERROR` 结束时有错误摘要 | 记录错误摘要；SDK 中通常通过 `setStatus({ code, message })` 写入，不调用 `setAttribute("status.message", ...)`。 |

子操作失败不自动使父操作失败：可恢复的 overflow 不结束 run/interaction；最终成功的重试不把逻辑 LLM span 标为失败；人工拒绝不把已完成的 permission 检查标为失败。清理时必须去重，已结束的 span 不再次修改。

## 12. 最小成功 Trace 示例

一次无工具调用的主会话：

```text
opencode.run                  gen_ai.operation.name=invoke_workflow
└── opencode.interaction      gen_ai.operation.name=invoke_agent
    └── opencode.llm          gen_ai.operation.name=chat
```

三个 span 均包含相同的 `session.id` / `gen_ai.conversation.id`，正常结束后 status 保持 `UNSET`。LLM messages 描述单次逻辑模型调用；interaction messages 描述一次用户交互；run input messages 按顺序包含任务内所有 interaction 的用户输入，run output messages 为最后一次 interaction 的最终输出。

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
