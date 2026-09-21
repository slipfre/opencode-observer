# Trace Schema：期望规范

本文定义项目期望表达的 trace 结构、span 职责和属性语义，用于讨论观测目标。插件实现可能因各种限制导致部分字段在当前条件下无法实现，本文档记录的是最初的目标，不代表当前插件已经实现全部字段。另外，插件也可能实本文档未记录的字段。

trace-opencode.md 记录了当前实际导出的结构、字段来源、创建条件和降级口径，并在[实现差距](trace-opencode.md#14-与期望规范的差距)中列出尚未实现或只能近似观测的部分。两份文档沿用相同的 span 章节顺序，便于对照；读取现有 OTLP 数据或编写实现测试时，以实现文档为准。

## 1. Schema 约定

### 1.1 规范基线

- 通用字段依据 [OTel Semantic Conventions v1.44.0][otel-semconv]。
- GenAI 字段与消息结构依据独立的 [GenAI Semantic Conventions 仓库][genai-root]，固定到提交 `b5d8440f6f126738fd50f927752cd669772c517b`。GenAI 仍处于 Development，升级基线时需重新检查字段、单位和 JSON Schema，不能自动跟随 `main`。
- 标准未覆盖的项目业务信息使用 `opencode.*` 扩展。下文的必填条件是项目约定，不等同于标准对所有 span 的统一要求。
- `trace_id`、`span_id`、`parent_span_id`、开始/结束时间、`kind`、`status` 和 events 属于 span envelope；resource 与 instrumentation scope 属于外层上下文，不重复导出为 span attributes。

### 1.2 类型、内容采集与缺省值

- `必有` 表示对应 span 应具备的字段；`条件` 表示仅在数据或关联存在时写入。未能可靠取得目标数据时必须省略或明确标记降级，不能为满足必填约定而猜测。
- `int` 是整数计数，`double` 是浮点值，`string[]` 是原生字符串数组。`JSON` 表示遵循相应 schema 的结构化值；可用结构化 attributes，或序列化一次的 JSON 字符串承载。本文示例展示序列化前的值，实际编码见实现文档。
- 缺失数据省略，不用 `0`、空字符串、空数组或 `unknown` 冒充实测值。已确认的零用量、空文本和空候选数组可以保留。`user.id=unknown` 是显式的身份未知标记，其使用条件见实现文档。
- 遥测、`captureContent` 和 `captureHttpHeaders` 默认关闭。正文、系统指令、工具调用参数/结果和 LLM 工具定义受 `captureContent` 控制；下文这些字段的条件隐含“正文开启且取得数据”。模型请求/响应 HTTP headers（含错误响应）还要求 `captureHttpHeaders` 开启；任一开关关闭时省略，不能用空值表示未采集。
- 输出类型、身份、模型、参数、用量、费用、计时和重试计数是元数据，不受正文开关控制。
- 正常结束保持 status 为 `UNSET`，失败设置 `ERROR`，不主动写入 `OK`。`UNSET` 不表示 span 尚未结束，结束由 end time 表达。[OTel 错误记录规范][otel-errors]

配置入口见 [README](../../README.md#配置)。

## 2. Resource 与 instrumentation scope

### 2.1 Resource attributes

| 字段                          | 类型   | 期望语义                                                                             |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `service.name`                | string | 遥测生产者服务名，默认 `opencode`。                                                  |
| `service.version`             | string | 运行中的 OpenCode 版本；未知时省略。                                                 |
| `os.type`                     | string | 主机操作系统的 OTel 标准值，例如 `windows`、`linux`、`darwin`。                      |
| `host.arch`                   | string | 主机 CPU 架构的 OTel 标准值，例如 `amd64`、`arm64`；不能将仿真进程架构当作主机架构。 |
| `<custom-resource-attribute>` | string | 自定义资源属性；覆盖标准字段时仍需满足其类型和语义。                                 |

插件名称 `opencode-observer` 与插件包版本记录在 instrumentation scope 的 `name` / `version`，不与 OpenCode 的 `service.version` 混用。[OS 字段][otel-os]、[Host 字段][otel-host]

### 2.2 公共 attributes

| 字段                         | 类型   | 出现条件                 | 期望语义                                                                      |
| ---------------------------- | ------ | ------------------------ | ----------------------------------------------------------------------------- |
| `session.id`                 | string | 所有 span 必有           | 当前操作所属的会话 ID。                                                       |
| `gen_ai.conversation.id`     | string | 所有 span 必有           | 与 `session.id` 相同，用于 GenAI 会话关联。                                   |
| `opencode.session.parent_id` | string | 父会话可识别             | 子 agent 的父会话 ID。                                                        |
| `user.id`                    | string | 已配置身份或发起身份解析 | 操作所属用户的身份；解析与未知值规则由实现文档明确。                          |
| `<custom-span-attribute>`    | string | 配置存在                 | 自定义属性；除显式配置的 `user.id` 外，不覆盖内建身份、类型、操作或派生字段。 |

子 agent 使用自己的会话 ID，不能用父会话 ID 替代。

## 3. Trace 拓扑

### 3.1 主会话

默认前缀为 `opencode.`；自定义前缀只改变 span 名称，不改变 attribute key 或 operation 值。

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

- 一个 run 对应一个任务执行周期，同一 session 可以先后产生多个独立 run。
- 一个 interaction 对应一次真实用户交互；同一 run 可包含多个 interaction。追加输入（steer）创建新 interaction，run 保持打开。
- LLM、tool 和 skill.load 同属 interaction，不将工具或技能加载挂在 LLM 下。正文中的 tool call 通过调用 ID 关联对应的 tool 或 skill.load span。
- 技能加载单独生成 skill.load，不再重复生成 tool.skill；后续 LLM 和工具不因加载技能而改挂到 skill.load 下。
- 权限检查挂在被检查的 tool 或 skill.load 下；自动压缩挂在所属 interaction 下；生成摘要的 LLM 挂在 compaction 下。
- 父子关系表达操作归属。steer 后仍在完成的旧操作保留原 parent，不能随当前交互改变归属，也不要求所有子 span 的结束时间早于父 span。

### 3.2 前台 subagent

```text
父 interaction
└── opencode.tool.task
    └── 子 opencode.run
        └── 子 opencode.interaction
            ├── 子 opencode.llm
            └── 子 opencode.tool.<tool-name>
```

前台子任务继承实际触发它的 task tool 上下文，形成同一 trace。子交互及其操作使用 `opencode.agent.type=subagent`。后台或无法证明调用关系的任务不能强行挂到前台 task tool。

### 3.3 根上下文与下游传播

顶层 run 从空上下文创建独立 trace；已关联的子 run 继承父 task tool。

可关联的模型请求应传播当前 LLM span 的 W3C `traceparent` 及非空 `tracestate`，以关联下游服务。身份传播与正文采集相互独立。未知或歧义归属不得传播猜测出的上下文；具体身份拼装、开关与宿主传输限制见实现文档。

## 4. Span 总览

所有 span 包含公共 attributes；下表的 operation 写入 `gen_ai.operation.name`。它不替代 OTel SpanKind。

| Span 名称                  | OTel kind  | operation                                                | Parent                        | 期望粒度                             |
| -------------------------- | ---------- | -------------------------------------------------------- | ----------------------------- | ------------------------------------ |
| `<prefix>run`              | `INTERNAL` | `invoke_workflow`                                        | 顶层无 parent，或父 task tool | 每个任务执行周期一个。               |
| `<prefix>interaction`      | `INTERNAL` | `invoke_agent`                                           | run                           | 每次真实用户交互一个。               |
| `<prefix>compaction`       | `INTERNAL` | 不设置                                                   | interaction                   | 每次上下文压缩一个。                 |
| `<prefix>llm`              | `CLIENT`   | `chat`、`generate_content`、`text_completion` 等实际操作 | interaction 或 compaction     | 每次逻辑模型调用一个，包含其重试。   |
| `<prefix>tool.<tool-name>` | `INTERNAL` | `execute_tool`                                           | interaction                   | 每次普通工具调用一个，不含技能加载。 |
| `<prefix>skill.load`       | `INTERNAL` | `execute_tool`                                           | interaction                   | 每次技能加载调用一个。               |
| `<prefix>permission.check` | `INTERNAL` | 不设置                                                   | tool 或 skill.load            | 每次人工权限检查一个。               |

compaction 与 permission 是普通内部操作，本规范基线没有与之直接对应的 GenAI 操作值，不伪造 `CHAIN`、`GUARDRAIL` 等值。[Agent / workflow span 规范][genai-agents]、[模型 / tool span 规范][genai-spans]

## 5. `<prefix>run`

run 覆盖任务从首个真实用户输入开始，到任务正常结束或终止失败的整个执行周期；steer 和可恢复的上下文溢出不结束 run。

| 字段                     | 类型   | 出现条件                 | 期望语义                                        |
| ------------------------ | ------ | ------------------------ | ----------------------------------------------- |
| `gen_ai.operation.name`  | string | 必有                     | `invoke_workflow`。                             |
| `opencode.run.id`        | string | 必有                     | 本次任务的稳定标识，不是 provider response ID。 |
| `gen_ai.input.messages`  | JSON   | 取得完整的任务级文本输入 | 按 interaction 顺序记录真实用户输入消息。       |
| `gen_ai.output.messages` | JSON   | 正常结束且最终答复已知   | 最后一个 interaction 的最终答复消息数组。       |

run 和 interaction 的正文范围是用户文本与最终 assistant 文本，不包含系统生成的续接文本、压缩摘要或未完成的中间回答。无法取得任务级完整文本输入时省略 run 输入，避免将部分输入表示为完整任务。

```json
[
  { "role": "user", "parts": [{ "type": "text", "content": "检查构建失败原因" }] },
  { "role": "user", "parts": [{ "type": "text", "content": "先检查依赖版本" }] }
]
```

同名 messages 属性在 LLM 上表示模型请求/响应，在 run 上表示任务输入/最终答复，观察范围不同。

## 6. `<prefix>interaction`

interaction 从本次真实用户输入开始，到任务结束、终止失败或下一次 steer 输入开始时结束。steer 时旧 interaction 正常结束，结束时间等于新 interaction 开始时间，已确定的子操作归属保持不变。

| 字段                      | 类型   | 出现条件                              | 期望语义                                                 |
| ------------------------- | ------ | ------------------------------------- | -------------------------------------------------------- |
| `gen_ai.operation.name`   | string | 必有                                  | `invoke_agent`。                                         |
| `opencode.interaction.id` | string | 必有                                  | 本次用户交互的稳定标识。                                 |
| `gen_ai.agent.name`       | string | 必有                                  | 接收本次用户交互的 agent 名称。                          |
| `opencode.agent.type`     | string | 必有                                  | `primary` 或 `subagent`。                                |
| `gen_ai.input.messages`   | JSON   | 用户文本可用                          | 单条 `role=user` 消息，文本放在 `parts[].content`。      |
| `gen_ai.output.messages`  | JSON   | 正常结束且最终答复已知，或 steer 结束 | 最终 assistant 消息；steer 时为 `[]`，表示没有最终答复。 |

已完成的空文本答复是 `[{"role":"assistant","parts":[{"type":"text","content":""}]}]`；它与 steer 的空数组、未采集而省略属性具有不同含义。自动续接和压缩标记不创建用户交互。

## 7. `<prefix>compaction`

compaction 覆盖一次上下文压缩从开始到成功或失败的周期；摘要生成是其子 LLM 操作。

| 字段                                     | 类型    | 出现条件                  | 期望语义                                    |
| ---------------------------------------- | ------- | ------------------------- | ------------------------------------------- |
| `gen_ai.agent.name`                      | string  | agent 可识别              | 所属 agent 名称。                           |
| `opencode.agent.type`                    | string  | agent 类型可识别          | `primary` 或 `subagent`。                   |
| `opencode.compaction.id`                 | string  | 必有                      | 本次压缩的稳定标识，同时用于关联摘要 LLM。  |
| `opencode.compaction.auto`               | boolean | 必有                      | 是否自动压缩。                              |
| `opencode.compaction.overflow`           | boolean | 必有                      | 是否由上下文溢出触发。                      |
| `opencode.compaction.trigger_message.id` | string  | overflow 触发且消息可识别 | 导致溢出的模型调用所对应的消息标识。        |
| `opencode.compaction.prompt_tokens`      | int     | 压缩成功且用量可用        | 摘要模型的输入 token 数，包含缓存输入。     |
| `opencode.compaction.summary_tokens`     | int     | 压缩成功且用量可用        | 摘要模型的输出 token 数，不包含 reasoning。 |

compaction 保留上述 prompt / summary tokens 业务字段，统计总用量时不能与子 LLM 重复相加。summary tokens 不包含 reasoning，标准 output tokens 包含 reasoning，两者不可互换。

## 8. `<prefix>llm`

### 8.1 身份、模型和用量

| 字段                                    | 类型     | 出现条件                     | 期望语义                                                                |
| --------------------------------------- | -------- | ---------------------------- | ----------------------------------------------------------------------- |
| `gen_ai.operation.name`                 | string   | 必有                         | 实际模型 API 操作，例如 `chat`、`generate_content`、`text_completion`。 |
| `gen_ai.provider.name`                  | string   | 必有                         | 标准 provider 名称；不能仅凭兼容协议认定供应商。                        |
| `gen_ai.request.model`                  | string   | 必有                         | 请求的模型 ID。                                                         |
| `gen_ai.response.model`                 | string   | 实际响应提供                 | 响应确认的模型名，不能用请求模型补造。                                  |
| `gen_ai.response.id`                    | string   | 实际响应提供                 | Provider response ID，不能用宿主消息 ID 替代。                          |
| `opencode.message.id`                   | string   | 必有                         | 逻辑模型调用对应的宿主 assistant 消息 ID。                              |
| `gen_ai.agent.name`                     | string   | agent 可识别                 | 所属 agent 名称。                                                       |
| `opencode.agent.type`                   | string   | 必有                         | `primary` 或 `subagent`。                                               |
| `opencode.compaction.id`                | string   | 摘要调用                     | 与父 compaction 相同的标识。                                            |
| `gen_ai.usage.input_tokens`             | int      | 请求成功且用量可用           | 输入总 token 数，包含缓存读取和写入。                                   |
| `gen_ai.usage.output_tokens`            | int      | 请求成功且用量可用           | 输出总 token 数，包含 reasoning。                                       |
| `gen_ai.usage.reasoning.output_tokens`  | int      | 对应分量可用                 | output tokens 的 reasoning 子集。                                       |
| `gen_ai.usage.cache_read.input_tokens`  | int      | 对应分量可用                 | input tokens 的缓存读取子集。                                           |
| `gen_ai.usage.cache_write.input_tokens` | int      | 对应分量可用                 | input tokens 的缓存写入子集。                                           |
| `opencode.llm.cost.total`               | double   | 请求成功且费用可用           | 费用，单位 USD；应说明是估算还是实际账单及其覆盖范围。                  |
| `gen_ai.response.finish_reasons`        | string[] | 结束原因已知，或生成异常终止 | 按输出候选顺序排列；异常缺失预期结束原因时使用 `error`。                |
| `gen_ai.response.time_to_first_chunk`   | double   | 首 chunk 可测量              | 秒，从逻辑调用开始到收到首个响应 chunk；不要求非空文本。                |

五个用量字段都只在请求成功且对应数据可用时写入。缓存与 reasoning 已包含在总量中，不能再次相加。总 token 数由 input + output 计算；本基线没有通用的 `gen_ai.usage.total_tokens` 或费用字段。

finish reasons 对应输出候选，不对应各次 retry。输出消息不再携带已弃用的 `finish_reason` JSON 属性。

### 8.2 消息与系统指令

| 字段                     | 类型 | 出现条件             | 期望语义                                                                              |
| ------------------------ | ---- | -------------------- | ------------------------------------------------------------------------------------- |
| `gen_ai.input.messages`  | JSON | 取得输入             | 实际模型请求消息，按发送顺序记录，采用 InputMessages 结构。                           |
| `gen_ai.output.messages` | JSON | 取得输出或确认空输出 | 当前生成的候选，采用 OutputMessages 结构；每个候选的内容片段放在同一个 `parts` 数组。 |

消息遵循 [InputMessages][genai-input-schema] / [OutputMessages][genai-output-schema]。支持的正文包括文本、reasoning、工具调用、工具响应和相应 schema 定义的多模态 part；保留片段顺序，不将未知对象整体透传。

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

后续输入中的工具结果使用 `role=tool` 与 `type=tool_call_response`，并保留同一 call ID：

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

系统指令保留在 input messages 的 `role=system` 消息中，例如 `{"role":"system","parts":[{"type":"text","content":"根据当前项目上下文回答用户问题。"}]}`，不单独导出系统指令字段。reasoning 使用 `reasoning` part，媒体 URL 使用 `uri`，二进制和 data URI 使用 base64 `blob`，不额外下载媒体。

### 8.3 请求参数、工具定义和 HTTP 属性

| 字段                         | 类型     | 期望语义                                                                                             |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `gen_ai.request.max_tokens`  | int      | 请求的最大输出 token 数。                                                                            |
| `gen_ai.request.temperature` | double   | 请求的 temperature。                                                                                 |
| `gen_ai.request.top_p`       | double   | 请求的 top-p。                                                                                       |
| `gen_ai.request.top_k`       | int      | 请求的 top-k。                                                                                       |
| `gen_ai.request.stream`      | boolean  | 本次请求是否使用流式响应。                                                                           |
| `gen_ai.output.type`         | string   | 请求的输出类型，例如 `text`、`json`；可记录由 SDK 配置和已知默认行为确认的类型，不根据生成文本猜测。 |
| `gen_ai.tool.definitions`    | JSON     | 当前请求可调用的有效工具集合，含可取得的描述和参数 schema。                                          |
| `http.request.header.<key>`  | string[] | 可关联的模型请求 headers，key 为小写 header 名。                                                     |
| `http.response.header.<key>` | string[] | 可关联的模型响应 headers，包括错误响应。                                                             |

参数仅记录实际取得的有效值，不能推测默认值。输出类型允许使用已确认的 SDK 默认行为：AI SDK 回调确认未配置 `output` 时记录 `text`；没有 SDK 快照或显式格式无法取得时省略。工具定义、headers 受正文开关控制；输出类型不受控制；不采集 seed。

工具定义遵循 [ToolDefinitions][genai-tools-schema]。函数工具使用顶层 `type=function` / `name`，参数采用 JSON Schema draft-07；provider 工具保留真实类型，不伪装为函数工具。已确认空工具集合为 `[]`，未知则省略。

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

HTTP header 即使只有一个值也是 `string[]`，例如 `http.request.header.content-type=["application/json"]`；保留名称中的连字符，不任意按逗号拆分多值。模型 headers 与 OTLP collector 的导出 headers 分开。[HTTP 字段规范][otel-http]

### 8.4 Retry attributes

| 字段                       | 类型 | 出现条件       | 期望语义                                                                   |
| -------------------------- | ---- | -------------- | -------------------------------------------------------------------------- |
| `opencode.llm.retry_count` | int  | 必有，初始 `0` | 宿主重试流程通知的次数，不含初次执行；包含已进入退避但尚未发出请求的重试。 |

此字段的目标范围就是宿主重试流程，不统计 SDK、鉴权或传输层的内部重发，也不以它推算实际网络请求数。仅记录计数，不扩展为重试原因、历史、预计时间或偏移量。精确 attempt 首块计时仍需独立的 attempt 边界证据。

### 8.5 生命周期与状态

期望通过 LLM span 描述逻辑模型调用的客户端耗时：从开始请求到响应流结束或终止失败，覆盖该调用的重试与退避。它不代表服务端纯推理时间，也不应将后续本地工具执行当作模型处理时间。

没有可靠请求边界时，实现必须说明采用的替代时间及其局限；首 chunk 近似值也必须标明来源，不能称为精确网络计时。时间戳无效或证据缺失时不补造测量。

最终成功的重试保持 `UNSET`，不保留终态 `error.type`；最终失败设置 `ERROR`。可恢复的模型错误独立结束该 LLM，父 run / interaction 可以继续。

## 9. `<prefix>tool.<tool-name>`

tool 从实际执行开始，到完成或失败时结束。调用身份、参数和结果应能与 LLM 消息中的工具调用对应。

| 字段                         | 类型   | 出现条件           | 期望语义                                 |
| ---------------------------- | ------ | ------------------ | ---------------------------------------- |
| `gen_ai.operation.name`      | string | 必有               | `execute_tool`。                         |
| `gen_ai.tool.call.id`        | string | 必有               | 工具调用 ID，不是存储该调用的 part ID。  |
| `gen_ai.tool.name`           | string | 必有               | 工具名称，同时用于 span 名称。           |
| `gen_ai.tool.description`    | string | 正文开启且描述可用 | 本次执行工具的描述。                     |
| `gen_ai.tool.call.arguments` | JSON   | 参数可用           | 调用参数对象。                           |
| `gen_ai.tool.call.result`    | JSON   | 成功且结果可用     | 工具结果对象；失败文本不能作为成功结果。 |
| `gen_ai.agent.name`          | string | agent 可识别       | 所属 agent 名称。                        |
| `opencode.agent.type`        | string | 必有               | `primary` 或 `subagent`。                |

参数与结果遵循 [ToolCallArguments][genai-tool-args-schema] / [ToolCallResult][genai-tool-result-schema]，本基线要求对象。纯文本结果可包装为 `{"content":"配置文件内容"}`；`content` 是本项目的结果对象约定。成功/失败由 span status 表达，不再导出重复的 `tool.success`。

## 10. `<prefix>skill.load`

skill.load 表示一次技能加载调用，沿用标准工具执行语义。它只覆盖加载操作，不表示执行该技能指导的整个任务。通过底层调用 ID 与模型消息及权限检查关联；同名技能的不同调用分别记录。

| 字段                              | 类型    | 出现条件                     | 期望语义                                                                                              |
| --------------------------------- | ------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `gen_ai.operation.name`           | string  | 必有                         | `execute_tool`。                                                                                      |
| `gen_ai.tool.name`                | string  | 必有                         | `skill`，具体技能名使用下方独立字段。                                                                 |
| `gen_ai.tool.call.id`             | string  | 必有                         | 底层调用 ID。                                                                                         |
| `gen_ai.agent.name`               | string  | agent 可识别                 | 所属 agent 名称。                                                                                     |
| `opencode.agent.type`             | string  | 必有                         | `primary` 或 `subagent`。                                                                             |
| `opencode.skill.name`             | string  | 名称可用                     | 所加载的技能名称，不受 `captureContent` 控制。                                                        |
| `ai.agent.skill.name`             | string  | 名称可用                     | 项目约定的额外名称字段，与 `opencode.skill.name` 同值并同步更新；不受正文开关控制，非 OTel 标准字段。 |
| `opencode.skill.directory`        | string  | 目录可用                     | 宿主报告的技能目录，不推导原始文件路径。                                                              |
| `opencode.skill.output`           | string  | 正文开启、加载成功且输出可用 | 实际返回文本，可包含说明、资源列表或截断提示，不等同于完整原始技能文件。                              |
| `opencode.skill.output.truncated` | boolean | 截断状态可用                 | 宿主是否截断返回文本；未知时省略。                                                                    |

名称、目录和截断状态是元数据，关闭正文仍可采集；不导出 `opencode.skill.trigger`，不重复记录完整工具参数和 `gen_ai.tool.call.result`。模型消息中的工具调用与响应保留原有格式，仍受正文开关控制。加载时长包含权限等待和结果准备，不等同于纯文件读取耗时；不推算技能 token、费用、版本或后续执行归属。

加载成功保持 `UNSET`，加载失败或提前终止设置 `ERROR`；已完成的权限拒绝检查保持 `UNSET`，因此失败的加载记录 `PermissionRejectedError`。缺失数据省略，重复和迟到事件不重建或改写已结束 span。

## 11. `<prefix>permission.check`

permission.check 覆盖人工权限请求的等待周期，从发起请求到收到答复或异常终止。它表示检查过程，不表示又执行一次工具，也不涵盖未进入人工等待的静默授权。

| 字段                               | 类型     | 出现条件     | 期望语义                                |
| ---------------------------------- | -------- | ------------ | --------------------------------------- |
| `gen_ai.agent.name`                | string   | agent 可识别 | 被检查工具所属 agent 名称。             |
| `opencode.agent.type`              | string   | 必有         | `primary` 或 `subagent`。               |
| `opencode.permission.tool.call.id` | string   | 必有         | 与父 tool 或 skill.load 相同的调用 ID。 |
| `opencode.permission.tool.name`    | string   | 必有         | 被检查的工具名；skill.load 为 `skill`。 |
| `opencode.permission.name`         | string   | 必有         | 权限类型。                              |
| `opencode.permission.patterns`     | string[] | 必有         | 请求匹配的 patterns。                   |
| `opencode.permission.reply`        | string   | 收到答复     | `once`、`always` 或 `reject`。          |
| `opencode.permission.granted`      | boolean  | 收到答复     | reply 不为 `reject` 时为 `true`。       |

工具关联使用 `opencode.permission.tool.*` 自定义属性，不设置 `gen_ai.tool.name`、`gen_ai.tool.call.id` 或 `gen_ai.operation.name=execute_tool`，避免观测后端将权限检查识别为工具执行或用工具名覆盖 span 名称。

收到拒绝也是检查流程正常完成，status 保持 `UNSET`，通过 `granted=false` 表示决策。调用因此失败时，由 tool 或 skill.load span 记录失败。检查尚未得到答复却提前终止时，permission span 才是 `ERROR`。

## 12. 状态与错误汇总

| 字段 / 位置                      | 类型   | 出现条件     | 期望语义                                                             |
| -------------------------------- | ------ | ------------ | -------------------------------------------------------------------- |
| `error.type`（attribute）        | string | `ERROR` 结束 | 源错误类型或稳定错误码，无法分类时为 `_OTHER`，不使用完整错误文本。  |
| `exception.message`（attribute） | string | `ERROR` 结束 | 与 `status.message` 相同的非空错误摘要，不受 `captureContent` 控制。 |
| `status.code`（envelope）        | enum   | 所有 span    | 正常为 `UNSET`，失败为 `ERROR`。                                     |
| `status.message`（envelope）     | string | `ERROR` 结束 | 非空错误摘要，不写成同名 span attribute。                            |

两个摘要字段优先保留有效源文本的原文。缺失、空字符串或纯空白摘要使用 `<error.type>: no error message provided`；类型为 `_OTHER` 或空白时使用 `Operation failed: no error message provided`。默认文本明确表示源摘要不可用，不推断具体失败原因；成功 span 不写入这两个字段。

子操作失败不自动使父操作失败；各 span 依据自身业务结果结束。重复或迟到数据不能修改已结束 span。进程崩溃等无法观察的终点不能补造为成功结束。

## 13. 最小成功 Trace 示例

```text
opencode.run                  gen_ai.operation.name=invoke_workflow
└── opencode.interaction       gen_ai.operation.name=invoke_agent
    └── opencode.llm           gen_ai.operation.name=chat
```

三个 span 使用相同的 session/conversation ID，正常结束后 status 为 `UNSET`。开启正文时，LLM messages 表示模型请求与生成内容，interaction messages 表示一次交互，run messages 表示整个任务的输入与最终答复。完整目标字段能否出现，需结合[当前实现及其差距](trace-opencode.md#14-与期望规范的差距)判断。

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
