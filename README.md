# opencode-observer

OpenCode 可观测性插件，使用 TypeScript 开发，通过 Bun 构建。

`src/index.ts` 导出符合 OpenCode `Plugin` 类型的 `ObserverPlugin`。目前已实现 [Trace Schema](docs/schemas/trace.md) 中的 run、interaction、LLM、tool、compaction 和 permission.check 六类 span，通过 OTLP HTTP/JSON 导出。

分层职责、依赖方向、接口约束及重构验收要求见 [架构实现 Spec](docs/spec.md)。

run、interaction 和 LLM 按三个独立目录实现：`src/adapter/` 适配 OpenCode hooks/events，`src/contract/` 定义观测契约，`src/telemetry/` 管理 OTel span 与导出。接入层与实现层只依赖契约，不能互相引用。`src/index.ts` 负责装配，`src/config.ts` 负责配置解析；各层不得反向依赖它们。

```text
src/
├── index.ts             # 插件装配入口
├── config.ts            # 配置解析
├── adapter/             # OpenCode 接入层
│   ├── opencode.ts      # hooks/events 与错误隔离
│   ├── coordinator.ts   # 原始事件解析、对象协调与恢复判断
│   ├── run.ts           # run 身份、输入去重与生命周期
│   ├── interaction.ts   # 交互边界、消息归属和最终答复
│   ├── llm.ts           # 模型 step、请求参数与用量解析
│   ├── tool.ts          # 工具执行、归属与失败分类
│   ├── compaction.ts    # 压缩过程、摘要归属与用量
│   ├── permission.ts    # 人工权限等待与回复
│   ├── session.ts       # session 父关系与前台 task 关联
│   ├── json.ts          # 消息与工具载荷的 JSON 快照
│   ├── ai-sdk.ts        # AI SDK 回调与模型请求关联
│   ├── messages.ts      # 源消息解析为契约对象
│   └── error.ts         # 源错误归一化
├── contract/            # 观测契约层
│   ├── observer.ts      # 接口与数据类型
│   └── messages.ts      # 消息与内容片段类型
└── telemetry/           # 遥测实现层
    ├── factory.ts       # SDK/exporter 配置与工厂
    ├── observer.ts      # 契约实现、导出队列及关闭顺序
    └── spans/           # 具体 span 实现
        ├── run.ts         # run span 状态
        ├── interaction.ts # interaction span 状态及父子关联
        ├── llm.ts         # LLM span 状态与属性映射
        ├── tool.ts        # 工具 span、参数与结果编码
        ├── compaction.ts  # 压缩 span 与摘要父上下文
        ├── permission.ts  # 权限 span 与人工决策
        ├── messages.ts    # 结构化消息的 GenAI 编码
        └── common.ts      # 共用的 span 配置与正文编码
```

接入层内部由 `opencode.ts` 连接宿主，`coordinator.ts` 识别原始事件和真实输入、协调各类 tracker 及恢复流程。`adapter/run.ts` 只接收解析后的用户输入和结束结果，不接收原始事件或持有子对象 tracker。

遥测实现层内部按 `factory → observer → spans` 组织依赖：工厂创建 SDK 和 Observer，Observer 协调契约调用、导出与关闭，`spans/` 管理各类 span 的状态和数据映射。

lint 检查类型导入及跨层引用，依赖测试检查实际静态与动态模块加载；分别随 `bun run check` 和 `bun run test` 执行。

一个 run 从任务的首个真实用户消息开始，在 session idle 或终止错误时结束。同一任务的 steer 输入累积在同一个 run 中，正常输出取最后一次用户交互的最终答复。synthetic 自动续接和 compaction marker 不创建新 run；可恢复的 context overflow 会等待压缩结果。重复结束事件和已结束 run 的迟到事件不会重复导出或改写 span。

每次真实用户输入创建一个 interaction，父节点为当前 run。steer 在新输入的创建时间结束旧 interaction，正文开启时将其最终输出记为 `[]`。正常 idle 时，interaction 使用所属最终 assistant 的完成时间结束；缺少完成时间或仅观察到工具调用时，使用 idle 观察时间进行错误清理，保持 run 原有结果。迟到答复不会修改已经结束的 interaction。

## 开发

需要 Bun 1.3.14 或更新版本。

```sh
bun install
bun run check
bun run test
bun run build
```

| 命令                   | 用途                                              |
| ---------------------- | ------------------------------------------------- |
| `bun run format`       | 使用 oxfmt 格式化                                 |
| `bun run format:check` | 检查格式                                          |
| `bun run lint`         | 使用 oxlint 检查代码                              |
| `bun run lint:fix`     | 自动修复可修复的 lint 问题                        |
| `bun run typecheck`    | 使用 TypeScript 检查类型                          |
| `bun run check`        | 依次执行格式、lint 和类型检查                     |
| `bun run build`        | 使用 Bun 构建 ESM，并使用 TypeScript 生成类型声明 |

构建产物位于 `dist/`，包含 `index.js`、source map 和 `index.d.ts`。执行 `bun pm pack` 时会自动检查并构建，打包内容包括 `dist/`、`package.json`、README 和 MIT 协议。

## 本地加载与启用

构建后，在 OpenCode 的 `opencode.json` 中指定入口文件的绝对 URL。以下路径对应此仓库在 Windows 上的位置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///D:/Codes/opencode-observer/dist/index.js",
      {
        "enabled": true,
        "endpoint": "http://localhost:4318",
        "captureContent": true
      }
    ]
  ]
}
```

移动仓库后需相应调整路径。

也可以通过环境变量配置。插件选项优先于对应环境变量；遥测和正文采集默认关闭。上面的示例同时开启两者。

| 插件选项                  | 环境变量                              | 默认值 / 格式                                              |
| ------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `enabled`                 | `OPENCODE_ENABLE_TELEMETRY`           | `false`；布尔环境变量接受 `true` / `false` / `1` / `0`     |
| `captureContent`          | `OPENCODE_CAPTURE_CONTENT`            | `false`；控制输入和输出正文                                |
| `endpoint`                | `OPENCODE_OTLP_ENDPOINT`              | `http://localhost:4318`；自动补齐 `/v1/traces`             |
| `tracePrefix`             | `OPENCODE_TRACE_PREFIX`               | `opencode.`                                                |
| `traceparent`             | `OPENCODE_TRACEPARENT`                | 可选 W3C 远端 parent；无效时创建新 trace                   |
| `tracestate`              | `OPENCODE_TRACESTATE`                 | 可选 W3C tracestate，需有效 parent                         |
| `otlpHeaders`             | `OPENCODE_OTLP_HEADERS`               | 选项使用字符串值对象；环境变量使用 `key=value,key2=value2` |
| `resourceAttributes`      | `OPENCODE_RESOURCE_ATTRIBUTES`        | 同上，可覆盖默认 resource 属性                             |
| `spanAttributes`          | `OPENCODE_SPAN_ATTRIBUTES`            | 同上；不能覆盖插件身份、标准操作、正文和错误字段           |
| `spanAttributeCountLimit` | `OPENCODE_SPAN_ATTRIBUTE_COUNT_LIMIT` | `4096`，正整数                                             |

正常结束保持 `UNSET`；失败写入 `ERROR`、`error.type` 和 status message。idle、session error 和 session 删除事件触发主动 flush，事件回调在本地处理完成后返回，不等待网络导出。实例释放及进程 `beforeExit` 时，先结束未完成 interaction，再结束 run，等待已有导出并关闭导出器；重复关闭共用一次关闭过程。

run / interaction 正文聚合记录真实用户文本和最终 assistant 文本，过滤 synthetic / ignored 文本和压缩摘要。只有附件而没有可用文本的输入不伪造空文本；当任务存在此类输入时省略整个 `gen_ai.input.messages`。未知或未完成的输出也省略，明确观察到的空文本输出则保留。

普通 LLM 和 tool 挂在所属 interaction 下；compaction 包含摘要 LLM，tool 包含可精确关联的 permission.check。前台 task 的 `state.metadata.sessionId` 在子 run 开始前可用时，子 run 挂到对应 task tool 下。子 span 保留自己的 session ID。session 父关系与 agent 类型从已观察的 session 事件或活动 task 关联取得，不补查 session、不把未知类型假定为 primary，也不事后改写父节点。

工具使用源 state 的执行时间，缺少 running 通知时可由终态快照补建；正文开启时记录参数与成功结果。权限使用本地观察时间，人工 reject 是正常完成的决策，随后关联工具失败时分类为 PermissionRejectedError。压缩成功记录摘要用量，覆盖、失败和提前关闭会清理未完成操作；关闭始终先结束后代再结束父对象。

LLM 由 `step-start` 确认创建，`step-finish` 提交正常结束及归一化用量；单独的 assistant 消息不创建 LLM span。两端均使用事件观察时间，包含事件处理开销，也可能包含工具等待，不能作为精确的模型请求耗时。`chat.params` 提供当前插件看到的模型和参数快照。不具备实际 attempt 起点探测时，retry 字段保持 `0` / `[]`，表示尚未确认重试开始。

开启 `OPENCODE_CAPTURE_CONTENT=true` 后，通过 AI SDK lifecycle 回调采集当前模型请求的历史消息、独立系统指令，以及当前 step 的文本、reasoning、工具调用和多模态输出；历史输入中的工具结果也会保留。适配层解析为契约对象，实现层编码为 `gen_ai.input.messages`、`gen_ai.output.messages` 和 `gen_ai.system_instructions`。关联使用具体 assistant 和请求标识，多个实例之间互不混用；内部标识在受支持的流式请求发往 provider 前移除。

该通道对接 OpenCode 的 AI SDK 6 `streamText` 路径，当前依赖 `ai@6.0.168`，采集的是 SDK 消息视图，后续 provider 转换仍可能改变请求。开启 `OPENCODE_EXPERIMENTAL_NATIVE_LLM`、无法精确关联或缺失回调时，继续以 owner 用户文本和可见 assistant 文本降级。正文采集默认关闭。暂不采集工具定义、HTTP headers、真实响应 ID/model 或首 chunk 耗时。

interaction 的 `agentName` 取 owner 用户消息，LLM 优先取 assistant 的 `agent`，兼容 `mode`。外部 W3C parent 仍由遥测实现从配置解析。未启用用户 ID 解析，因此默认省略 `user.id`；后续解析器可为新建 run 和 interaction 提供身份，LLM 使用所属 interaction 的身份快照，既有 span 不回填。

## 协议

[MIT](LICENSE)
