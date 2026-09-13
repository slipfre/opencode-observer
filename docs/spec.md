# 架构实现 Spec

本文定义 opencode-observer 的目标架构、模块职责、依赖方向和接口约束，作为实现与重构的依据。当前已实现 run、interaction、LLM、tool、compaction 和 permission.check 六类 span，范围与模块对应见第 7 节。

[Trace Schema](schemas/trace.md) 定义观测行为的口径、trace 拓扑、span 属性和导出格式；本文定义这些要求由哪一层负责。实现必须同时满足两份文档。调整分层不得隐式改变 Trace Schema 中的行为和数据口径。

## 1. 实现原则

- 将 OpenCode 行为的识别与遥测数据的构建、导出分离。
- 使用 TypeScript 实现，继续使用 Bun 开发、测试和构建。
- 首先通过模块边界落实分层，不要求拆分为三个独立包，也不引入跨进程通信。
- 每条行为规则只在一处实现；同一生命周期判断不得在适配层和实现层分别维护。
- 接口按当前实际实现的观测行为逐步增加，不要求一次性实现 Trace Schema 中的全部对象。

## 2. 三层职责

### 2.1 OpenCode 适配层

对接 OpenCode 的 hooks 和 events，解析原始数据，识别任务、交互、模型调用和工具执行等行为，并通过观测契约提交对应的生命周期变化及数据。

负责：

- 注册和处理 hooks、events，以及模型正文所需的 AI SDK lifecycle 回调，隔离源 SDK 的类型、字段结构和版本差异。
- 根据源事件识别观测对象的开始、更新、结束及结果。
- 维护解释 OpenCode 行为所需的状态，例如 synthetic 消息归属、steer 交互边界、compaction 与 overflow 恢复过程。
- 解析 session、message、tool call 等源标识，确定对象身份、归属和父子关联，通过契约中的标识或引用传递。
- 提取结构化正文、用量、错误和时间等数据，区分真实发生时间与本地观察时间。源数据无法支持精确测量时，按 Trace Schema 降级或省略。
- 在正文采集关闭时，避免为遥测保留或传递正文。

不得直接创建或修改 OTel span、拼装 OTLP payload、操作 provider 或 exporter，也不得将原始 OpenCode `Event`、`Message`、`Part` 对象直接透传给实现层。

适配层允许有状态。仅将字段改名、再把行为识别留给实现层，不满足本层职责。

### 2.2 观测契约层

定义观测对象、数据结构和操作接口，约定各类行为的标识、父子关系、开始与结束、数据更新及错误语义，为适配层与实现层提供稳定的协作边界。

负责定义：

- run、interaction、模型调用、工具执行、compaction 和权限检查。
- 每类对象的输入数据、稳定标识、关联引用及时间字段。
- 对象开始、更新和结束等行为接口，以及 `flush`、`shutdown` 生命周期接口。
- 可选数据、未知值、错误、重复调用和迟到更新的处理约定。
- 同步与异步边界，以及失败如何反馈给调用方或诊断通道。

契约必须使用自身定义的数据类型，不得依赖 OpenCode SDK 或 OpenTelemetry SDK，不得暴露 `Event`、`Span`、`Tracer`、`Context`、provider 或 exporter 等第三方类型。

契约层不处理源事件、不维护运行状态、不执行网络请求。接口调用在运行时直接落到注入的实现上，无需增加一个仅负责转发的方法层。

### 2.3 遥测实现层

实现观测契约，维护观测对象对应的遥测状态，组织数据，并按照 Trace Schema 构建 span 及其属性。使用 OpenTelemetry SDK 和 OTLP exporter 完成批量导出、刷新及关闭。

负责：

- 维护观测对象标识到 span 的映射，以及 span 的创建、更新、结束和清理。
- 将契约中明确提供的父子关联转换为 trace/span 关联，管理 OTel context。
- 按契约聚合数据，并按 Trace Schema 设置 span 名称、属性、状态、正文编码、resource 和 instrumentation scope。
- 保证重复结束不重复导出，已经结束的对象不被迟到更新改写。
- 配置和管理 OTel SDK、span processor、OTLP exporter、导出队列及超时。
- 实现 `flush`、`shutdown`，报告遥测处理和导出失败。
- 将入口传入的 `spanAttributes` 写入新建 span，包括配置中的 `user.id`。

实现层不得依赖 OpenCode SDK 或 AI SDK，不得判断原始事件类型、读取原始消息字段来重新推断业务行为，也不得调用 OpenCode client 补查源数据。

OTel SDK 负责遥测构建与处理，OTLP 是导出协议。实现应使用三方 SDK 和 exporter，不自行实现 OTLP 编码或传输协议。

## 3. 依赖与装配

代码依赖关系：

```text
OpenCode 适配层 ──依赖──> 观测契约层 <──依赖并实现── 遥测实现层
插件入口 ──初始化──> 独立 user 模块
```

运行时数据流：

```text
OpenCode hooks / events、AI SDK lifecycle 回调
    → 适配层识别行为与数据
    → 调用观测契约
    → 遥测实现处理
    → OpenTelemetry SDK / OTLP exporter
    → 接收端
```

插件入口是装配位置，负责读取配置、调用 user 模块解析身份、创建实现、注入适配层，并连接日志和进程生命周期。入口可以同时依赖 user 模块、适配层和实现层，以完成创建和注入；事件处理代码必须通过契约使用实现，不能借入口绕过边界。

配置应按职责传入对应模块。遥测关闭时，不创建遥测实现或注册采集逻辑；仅在启用遥测的路径中加载 OTel 实现及其较重的依赖。AI SDK 正文采集模块由适配层按需加载，仅在遥测与正文采集均开启、且使用支持的模型运行路径时注册。

三层必须分别位于 `src/adapter/`、`src/contract/` 和 `src/telemetry/`。用户身份逻辑单独位于 `src/user/`，不属于适配层或遥测实现层。根目录的 `src/index.ts`、`src/config.ts` 仅负责装配与配置解析，不放置行为识别、契约或遥测实现代码。

| 目录             | 允许的依赖                                         | 禁止的依赖                                                    |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| `src/adapter/`   | 本层模块、观测契约、OpenCode SDK、AI SDK、平台库   | user 模块、遥测实现、OTel SDK、根目录装配与配置模块           |
| `src/contract/`  | 本层契约类型                                       | 适配层、实现层、第三方 SDK、根目录装配与配置模块              |
| `src/telemetry/` | 本层模块、观测契约、OTel SDK、平台库及包版本元数据 | 适配层、user 模块、OpenCode SDK、AI SDK、根目录装配与配置模块 |
| `src/user/`      | 本模块、平台库                                     | 适配层、观测契约、遥测实现、第三方 SDK、根目录装配与配置模块  |

实现层定义自身需要的配置类型，由入口传入匹配的配置数据；不得导入配置解析函数或通过 `ReturnType<typeof loadConfig>` 反向耦合根目录。类型导入、重导出和动态 `import()` 同样遵守层间边界。

适配层内部按职责组织为四个目录：

- `opencode/`：宿主 hooks/events 接入、跨对象协调、session 关联和版本查询。
- `trackers/`：run、interaction、LLM、tool、compaction 和 permission 的生命周期状态。
- `model/`：AI SDK 消息采集、消息解析、请求参数与 provider 识别、模型用量归一化。
- `shared/`：跨模块共用的 JSON 快照、错误归一化和非负数值校验。

`opencode/` 可以使用其余三个目录，`trackers/` 可以使用 `model/` 和 `shared/`，`model/` 可以使用 `shared/`；公共转换不反向依赖行为跟踪或宿主协调。模型请求类型属于 `model/request.ts`，AI SDK 采集模块不依赖 tracker。LLM step 与已完成 compaction 摘要共用 `model/usage.ts`，只在组成项有效且总和仍为安全整数时报告合计 token 用量。

`opencode/hooks.ts` 连接宿主 hooks、错误隔离和刷新，`opencode/coordinator.ts` 解析原始事件并协调各类观测对象。协调模块负责真实输入识别、按 session 创建各类 tracker、overflow / compaction 恢复判断、模型请求路由和结束顺序。`opencode/session.ts` 保留已观察的 session 父关系与活动 task 关联。各对象模块不承担整个适配层的事件分发，也不直接创建或调用其他对象的 tracker；跨对象动作通过协调模块注入的回调完成。

`adapter/trackers/run.ts` 只依赖观测契约，接收解析后的用户输入和明确的结束结果，维护 run 身份、输入去重及开始 / 结束状态；不接收 OpenCode `Event`、`UserMessage` 或 `Part`，不持有 interaction / LLM tracker，也不注册或转发 AI SDK 请求。run 的接口为 `userInput()`、`finish()` 和 `close()`。interaction / LLM 可在各自模块内解析已分发给它们的源消息与片段。

遥测实现层内部按 `factory → observer → spans` 组织依赖。`factory.ts` 负责创建 SDK、exporter 和 Observer；`observer.ts` 实现契约并协调记录、导出与关闭；具体 span 的状态管理和数据映射放在 `spans/`，共用配置类型和文本编码放在 `spans/common.ts`，结构化消息编码放在 `spans/messages.ts`。`spans/` 不反向依赖工厂或 Observer 实现。

用户身份逻辑集中在 `src/user/`，由插件入口直接调用，不经过适配层。`user/resolve.ts` 提供异步 `resolveUser(env)`，读取并校验专用的 `OPENCODE_USER_ID_*` 环境变量，再调用 `user/lookup.ts` 的 `lookupUser(token, options)`。`resolveUser` 在成功时返回 `User`，查询及重试最终失败时返回 `null`，因开关关闭、地址无效或 token 为空而跳过查询时返回 `undefined`。`lookup.ts` 定义 `User = { id: string }` 和 `UserLookupOptions`，负责 HTTP 请求、响应校验、超时和有限重试，返回 `User` 或 `undefined`，不读取环境变量。user 模块只依赖自身和平台库，不依赖观测契约、OpenCode 或 OTel，不读取 provider 配置，也不维护 pending、缓存或冷却状态。

入口等待 `resolveUser` 完成，将有效的 `user.id` 合并进配置中的 `spanAttributes`，然后调用原有的 telemetry factory。初始化查询可能延长启动；请求失败或超时在有限重试后继续启动并保留静态配置中的身份，没有静态配置则写入 `user.id=unknown`。跳过查询时仅保留静态配置，没有静态配置则省略。telemetry 不接收身份回调，不增加专用 processor 或契约类型，只沿用六类 span 的 attributes 展开逻辑。为兼容此通道，`user.id` 允许通过属性过滤，身份字段缺失时不覆盖配置值。优先级为契约显式非空身份、初始化查询结果、静态配置、查询失败时的 `unknown` 兜底值。初始化后使用固定快照，不随 token 或环境变量变化刷新。

`.oxlintrc.json` 对三层和独立 user 模块配置导入限制，覆盖类型导入和重导出。`tests/boundaries.test.ts` 检查模块的实际静态与动态依赖，并将相对路径解析后判断目标目录，避免通过相对路径绕过目录边界。

## 4. 状态与规则归属

| 规则或状态                                             | 负责层          |
| ------------------------------------------------------ | --------------- |
| 判断用户消息是否为真实输入，synthetic 是否属于已有交互 | OpenCode 适配层 |
| 判断 steer 是否创建新 interaction，是否延续当前 run    | OpenCode 适配层 |
| 判断 overflow 是否可恢复、压缩是否成功、任务是否终止   | OpenCode 适配层 |
| 识别最终答复及其归属，关联 tool call 与子 session      | OpenCode 适配层 |
| 定义对象标识、父子引用、时间单位和终态含义             | 观测契约层      |
| 根据明确的对象引用关联父 span，维护对象到 span 的映射  | 遥测实现层      |
| 聚合已归属的输入和输出，映射属性、状态并序列化         | 遥测实现层      |
| span 结束去重、拒绝已结束对象的迟到更新、资源清理      | 遥测实现层      |
| 批量导出、刷新、关闭和导出超时                         | 遥测实现层      |

例如，可恢复的 overflow 到达时，适配层根据 OpenCode 行为等待恢复结果，不提前提交 run 终止。确认恢复失败后，适配层才提交带错误的结束操作；实现层据此结束对应 span，不再次识别 overflow 或 compaction 事件。

适配层为识别行为维护的活动 run 状态，与实现层为管理 span 维护的映射具有不同用途。实现层依据契约调用推进状态，不独立推断 run 的业务边界。

## 5. 接口设计约束

### 5.1 以行为为中心

接口应表达已识别的观测行为，例如 `startRun`、`updateRun`、`finishRun`。这些名称用于说明接口粒度，具体签名在实现对应对象时确定。

不得以接收原始事件的 `event(Event)` 作为层间接口，也不得仅提供 `startSpan`、`setAttribute` 等 OTel API 的通用包装，把遥测结构的构建责任交回适配层。

接口接收结构化业务数据。标准 attribute key、span kind、OTel status 和 JSON 序列化由实现层按 Trace Schema 映射。

### 5.2 标识、时间和关联

- 对象标识必须稳定，并明确其作用域，避免不同 session 或不同对象类型之间冲突。
- 更新和结束操作必须指向明确的对象，不能依据调用时的“当前交互”猜测归属。
- 父子关系通过契约定义的对象引用表达，适配层不持有 OTel span 或 context。
- 时间统一使用 Unix epoch 毫秒，契约明确字段代表发生时间还是观察时间。遥测实现不得用导出或异步处理时间替代行为时间。
- 对于源数据缺失、无法精确关联或只观察到结束的情况，按 Trace Schema 的具体规则降级、补建或省略，不伪造开始时间或父子关系。

### 5.3 数据更新与终态

- 每个更新字段必须明确使用快照替换还是增量追加；增量数据必须有可去重的身份，不能因 hook 与 event 重复通知而重复累加。
- 区分未提供、明确为空和明确清除。缺失数据不能用 `0`、空字符串或空数组冒充。
- 错误使用契约定义的结构化类型和可选摘要，不直接暴露源 SDK 的异常对象。
- 已结束对象不因重复结束或迟到更新而重新创建或修改；对象结束不等同于网络导出成功。
- 正文采集策略必须贯穿适配与实现，导出字段和缺省值遵循 Trace Schema。

### 5.4 执行与失败

- 日常开始、更新和结束操作在本地处理，不等待 OTLP 网络请求；异步导出不阻塞后续 hook，也不改变记录的时间边界。
- 遥测处理异常通过插件日志或注入的诊断通道报告，不改变 OpenCode 的业务结果，也不修改 hook 的业务输出。
- 适配层通过 `shared/guard.ts` 创建绑定日志函数的 `guard`，覆盖 OpenCode hooks、后台刷新和 AI SDK lifecycle 回调；调用立即执行，同步异常及返回 Promise 的拒绝均在边界处理。日志不阻塞回调，日志自身的同步异常和异步拒绝直接忽略。AI SDK 按监听器分别隔离，并保护共享回调中的关联 header 清理；共享回调的诊断仅发送给仍活动的实例。
- 实现层的诊断通道不得依赖 OpenCode client；插件入口负责将诊断接到 OpenCode 日志。
- 导出队列、超时及失败处理由实现层统一管理，不在各个 hook 中维护导出队列或自行重试。

## 6. 刷新与关闭

`flush(): Promise<void>` 请求导出调用前已结束并进入处理队列的遥测数据，不结束仍在进行的观测对象。适配层可以根据业务边界发起刷新，但不等待刷新后再处理下一条源事件。

`shutdown(): Promise<void>` 停止接收新观测操作，按 Trace Schema 清理未完成对象，等待待处理的刷新并关闭 SDK 和 exporter。清理、刷新和关闭必须有明确顺序，网络等待受配置的超时约束。

关闭必须幂等：多次调用共享同一次关闭过程，不重复结束对象或关闭 exporter。关闭开始后的记录操作不再修改遥测状态。

`flush`、`shutdown` 的失败通过 Promise 拒绝反馈，由调用边界接入诊断处理，不作为 OpenCode 任务失败向业务传播。日常事件处理不得直接操作 `provider.forceFlush()` 或 `provider.shutdown()`。

当前适配层在 session idle、session error 和 session 删除事件后请求 `flush`，事件回调完成本地处理后返回，不等待网络导出。插件通过宿主 `dispose` hook 接入实例释放，并保留匹配目录的 `server.instance.disposed` 事件及进程 `beforeExit` 作为关闭入口：先释放适配层状态和监听器，再由遥测实现按后代优先顺序结束活动 span，等待已有导出并关闭导出器。`dispose` 等待关闭完成，重复关闭不重复导出，关闭异常通过诊断处理隔离。

## 7. 各类 span 的实现

当前支持 Trace Schema 中的全部六类 span。普通 LLM 和 tool 挂在所属 interaction 下，摘要 LLM 挂在 compaction 下，permission.check 挂在精确关联的活动 tool 下，前台 subagent run 可挂在父 task tool 下。创建仍要求对应的源行为证据与可识别的父对象。

| 模块                                  | 职责                                                     |
| ------------------------------------- | -------------------------------------------------------- |
| `src/index.ts`                        | 配置、依赖注入、日志及宿主生命周期装配                   |
| `src/adapter/opencode/hooks.ts`       | hooks/events 接入、错误隔离和刷新触发                    |
| `src/adapter/opencode/coordinator.ts` | 原始事件解析、真实输入识别、对象协调、恢复判断及请求路由 |
| `src/adapter/opencode/session.ts`     | session 元数据及活动前台 task 的子 session 关联          |
| `src/adapter/opencode/version.ts`     | 通过宿主 client 查询 OpenCode 版本及超时降级             |
| `src/adapter/trackers/run.ts`         | 已识别输入的去重、run 身份及开始 / 结束状态              |
| `src/adapter/trackers/interaction.ts` | 交互边界、消息归属和最终答复选择                         |
| `src/adapter/trackers/llm.ts`         | 模型调用证据、step 生命周期、请求及消息快照关联          |
| `src/adapter/trackers/tool.ts`        | 工具状态快照、assistant 归属、源时间与失败分类           |
| `src/adapter/trackers/compaction.ts`  | 压缩 marker、摘要归属、完成用量及替换 / 失败处理         |
| `src/adapter/trackers/permission.ts`  | 人工权限等待、精确工具关联、回复及待处理容量管理         |
| `src/adapter/model/ai-sdk.ts`         | AI SDK 回调注册、请求关联、实例隔离及释放                |
| `src/adapter/model/messages.ts`       | 将 AI SDK 输入和输出解析为契约消息快照                   |
| `src/adapter/model/request.ts`        | 模型请求类型、参数快照、provider 与 operation 识别       |
| `src/adapter/model/usage.ts`          | LLM 和 compaction 共用的 token 用量归一化                |
| `src/adapter/shared/json.ts`          | 消息和工具载荷共用的 JSON 值快照转换                     |
| `src/adapter/shared/error.ts`         | 源错误归一化，供各类观测对象使用                         |
| `src/adapter/shared/number.ts`        | 非负有限数值及安全整数校验                               |
| `src/contract/observer.ts`            | `Observer` 契约、各类观测对象及关联类型，无第三方依赖    |
| `src/contract/messages.ts`            | 与 SDK 无关的消息、片段、媒体来源和 JSON 数据类型        |
| `src/telemetry/factory.ts`            | OTel SDK、OTLP exporter 和 resource 配置                 |
| `src/telemetry/observer.ts`           | 契约实现、共用属性保护、导出队列与关闭顺序               |
| `src/telemetry/spans/run.ts`          | run span 管理、数据映射、上下文查找及结束去重            |
| `src/telemetry/spans/interaction.ts`  | interaction span 管理、父子关联、数据映射及结束去重      |
| `src/telemetry/spans/llm.ts`          | LLM span 管理、父子关联、用量与参数映射及结束去重        |
| `src/telemetry/spans/tool.ts`         | tool span、任务父上下文、参数及结果的 GenAI 编码         |
| `src/telemetry/spans/compaction.ts`   | compaction span、摘要父上下文及用量镜像                  |
| `src/telemetry/spans/permission.ts`   | permission span、人工决策属性及未回复请求清理            |
| `src/telemetry/spans/messages.ts`     | 将契约消息映射为 GenAI parts，并序列化为属性字符串       |
| `src/telemetry/spans/common.ts`       | 实现层共用的 span 配置类型和正文编码                     |

契约提供 run、interaction、LLM、tool、compaction 和 permission 的 start / finish 操作，以及 `updateRun`、`updateLlm`、`updateTool`、`flush` 和 `shutdown`。run 使用 session ID 与首个真实用户消息 ID 共同定位；输入以消息 ID 去重，重复更新保留首次快照；最终输出在结束时提交，`undefined` 表示未知，空字符串表示已知空文本。

协调模块把真实用户输入转换为 `{ sessionID, id, createdAt, text }` 交给 run tracker。run tracker 接受新输入后返回所属 run 引用、文本和用户身份快照；协调模块据此启动 interaction，并通知 LLM tracker 重新解析归属。重复输入返回未接受，不触发子对象更新。synthetic 续接由协调模块直接交给 interaction / LLM，不经过 run 的输入接口。跨 run 的输入去重记录仅由 run tracker 保留。

interaction 通过 `run: RunReference` 和 owner 用户消息 ID 定位。开始时提交输入及 agent 名称；结束时区分 `completed`、`superseded`、`failed` 三种契约状态。`completed` 携带最终输出快照，`superseded` 表达 steer 结束，`failed` 携带共用的 `ObservationError`。OTel 状态和正文格式由实现层映射；正文关闭时三种结果均不导出正文。

steer 结束旧 interaction 的时间等于新用户输入的创建时间，正常状态为 `UNSET`，正文开启时输出 `[]`。正常 idle 时，interaction 以所属最后一个非摘要 assistant 的 `time.completed` 结束；缺少完成时间或最后一步只有工具调用时，以 idle 观察时间作 `ERROR` 清理，不使用旧 assistant 的答复或完成时间。终止错误使用观察时间结束。可恢复 overflow 保持 run 和 interaction 打开；压缩摘要不成为最终答复。

消息归属与最终答复选择由 interaction tracker 维护，协调模块将归属解析函数提供给 LLM、tool 和 compaction tracker，并将最终答复作为 run 结束结果提交，生命周期规则不重复实现。interaction 的局部错误或缺少完成信息不自动将 run 标为失败。协调模块与实现层均保证先结束后代再结束父对象：permission 先于 tool，摘要 LLM 先于 compaction，子 run 先于父 task tool，当前 run 内的操作先于 interaction / run。适配层 `close()` 只释放源状态和绑定，插件关闭时由遥测实现统一结束仍活动的 span。

run 的 `parent` 使用明确的 `ToolReference`；摘要 LLM 的 `compactionID` 与其 compaction 父节点一致。已观察到 `session.created/updated` 时，通过 `parentID` 判断 primary / subagent；活动 task 关联也可以确认 subagent。相应的新 span 使用 `parentSessionID` 与 `agentType`，缺失证据时仍为 `undefined`，不假定 primary 或事后修改既有 span 的父节点。interaction 的 `agentName` 从 owner 用户消息取得；LLM / tool 优先使用 assistant 的 `agent`，兼容 `mode`。`userID` 使用所属 interaction 的身份快照。顶层 run 由遥测实现从空上下文创建独立 trace。

插件入口直接调用独立 user 模块取得身份，将其合并为 `spanAttributes["user.id"]`，telemetry 在六类 span 创建时展开该配置；查询失败且没有静态配置时使用 `unknown`，跳过查询且没有静态配置时省略。适配层 tracker 预留的解析器仍可为契约调用提供显式身份，LLM 使用所属 interaction 的身份快照，显式非空身份优先；已创建的 span 不回填。

适配层保留已接收用户输入的标识，实现层保留各类已结束对象的标识，直到插件关闭；去重记录不保留正文，关闭时释放。重复用户 hook 不创建新任务或交互，也不将旧输入追加到下一次 run。迟到输出不修改已结束对象的输出或结束时间。已结束 interaction 与 compaction 的轻量 OTel context 保留至 run 结束，供已确认归属的操作关联原 parent。

### 7.1 LLM 的事件生命周期

LLM 使用所属 `InteractionReference` 和 assistant message ID 定位，适配层复用 interaction 的真实输入与 synthetic owner 解析，不另建一套“当前交互”判断。仅在观察到 `step-start` 且能够确定 assistant 和 parent 时创建，起点保留首次 step 的本地观察时间。摘要调用从 compaction tracker 解析所属 interaction 和 compaction ID。只有 assistant 消息、只有 `step-finish`、无法关联 owner 或缺少 compaction 父节点时省略；不补造开始时间或父节点。step 事件先于消息元数据时，可以等待元数据再按原观察时间记录。

`step-finish` 提交正常结束，终点取该事件的观察时间；assistant 错误和会话错误提交失败。可恢复 overflow 结束失败的 LLM，但保留 run / interaction 等待恢复。idle、删除和关闭清理未结束 LLM；正常父操作不因子 LLM 失败而自动标错。实现层关闭顺序为 LLM、interaction、run；steer 只结束旧 interaction，既有和迟到的旧 LLM 继续使用原 parent。

这些时间是事件可见边界，不能声称是网络请求或响应流的精确边界；step 事件的投递、快照处理和工具等待可能影响耗时。AI SDK lifecycle 回调目前只补充正文，不改变 span 时间和用量来源，不使用 `assistant.time.created/completed` 或首个文本事件补造精确请求时间、TTFC 或 attempt 起点。

同一 assistant 的重复 step / 重试保留一个逻辑 LLM span。新 step 清理前一 attempt 的文本快照，忽略前一 attempt 已知文本 part 的迟到更新；重复 step ID 不清空当前输出。`session.status.retry` 的 `next` 不作为开始证据；当前不能精确确认 attempt 起点，因此 `retry_count=0`、`retry_history=[]` 仅表示未确认重试开始，不代表没有重试。

参数由 `chat.params` 按 user message ID、provider ID、配置 model ID 和 agent 匹配，记录本插件观察到的快照，不修改 hook output。该快照可能被后续插件修改，不等同于线上请求抓包。已匹配时请求模型使用 `model.api.id`，否则保留 assistant 的配置 model ID；响应模型与响应 ID 不由这些值代填。适配层识别 provider 及操作类型，契约传递操作和流式标识，实现层仅映射属性。没有采集到的参数省略，不从不透明 provider options 推断默认值。

`step-finish` 的归一化用量中，输入为 input + cache read + cache write，输出为 output + reasoning；同时保留 reasoning、cache read、cache write 分量和 cost。仅接受有限非负数，token 必须为安全整数；缺少某个求和分量时省略对应总量。不能用 assistant 创建时初始化的零用量冒充完成 usage。失败 LLM 不导出成功 usage / cost；成功零值正常保留。

正文开启时，优先使用第 7.2 节的结构化消息；没有取得对应快照时，输入 fallback 为 owner 用户文本，输出 fallback 为当前调用可观察到的 assistant 文本。同一文本 part 更新替换、删除移除，已知空文本与未知输出区分。正文关闭时，适配层不保留或传递正文，实现层再次执行采集开关。当前仍不采集工具定义、HTTP headers、真实响应 ID/model 或下游 trace 注入。自定义属性不能伪造这些未采集数据，也不能覆盖内建 GenAI 字段。

已有 run 的 Trace Schema 和测试所约定的行为继续保持。新增其他观测对象时遵循相同边界，再扩展父对象引用和对应字段；具体文件数量根据实现复杂度决定，不增加空转发模块。

### 7.2 LLM 结构化消息采集

使用 AI SDK 6 的 `registerTelemetryIntegration`，当前依赖固定为 `ai@6.0.168`，对接 OpenCode 的 `streamText` 路径。生命周期回调独立于宿主是否开启 AI SDK 的 OTel 导出。`OPENCODE_EXPERIMENTAL_NATIVE_LLM` 开启时，原生运行路径绕过这些回调，因此跳过该采集模块，继续使用事件文本降级。

`chat.headers` 在当前 session 内按 user message ID、provider、配置 model ID 和 agent，匹配唯一的未完成 assistant，并附加一次性关联标识。普通调用要求可解析 interaction，摘要调用要求可解析 compaction。AI SDK `onStart` 将标识绑定到此次调用的 metadata 对象，随后移除标识，避免发送给模型服务。后续回调同时校验 `functionId=session.llm`、metadata 对象身份和绑定的有效性。不能仅凭 session ID 归属消息；未匹配、匹配歧义、标题和缺少父节点的摘要调用均不采集。

回调通过进程内单个分发器注册，各插件实例只接收自身已绑定的调用；释放实例时移除监听器、清理待关联记录，已释放绑定不再接受正文。关联标识属于适配层内部数据，不进入契约或 span；消息采集关闭时不添加标识，也不访问 AI SDK 正文。

`onStepStart` 采集当前 step 的 `messages`，保留消息顺序、角色和支持的内容片段，包含实际传入 SDK 的历史上下文。单独提供的 `system` 作为系统指令；两处均无 system 时，才使用 provider options 中的 `instructions`。这反映 `prepareStep` 后的 SDK 消息视图，后续 provider middleware 和协议转换仍可能改变线上请求，不等同于原始 HTTP payload。

`onStepFinish` 优先使用当前 step 的 `content`，将文本、reasoning、工具调用及生成文件组成 assistant 候选；工具执行产生的结果不作为模型输出。只有 `content` 不可用时才从 `response.messages` 中取最后一个 assistant，避免将累积的历史 step 和 tool 结果混入当前输出。历史请求中的 tool 结果正常保留。

适配层将源消息转换为 `ModelInput`、`ModelMessage` 和 `ModelPart`。契约仅包含角色、文本、reasoning、工具调用及结果、媒体 URI 或 base64 数据；工具参数尽量解析为 JSON，无法解析的参数字符串保留原值。媒体不额外下载，未知片段省略，循环引用等无法表达的值不透传。实现层将这些对象映射为 GenAI 的 `text`、`reasoning`、`tool_call`、`tool_call_response`、`uri`、`blob` parts，再进行一次 JSON 序列化，分别写入 `gen_ai.input.messages`、`gen_ai.output.messages` 和 `gen_ai.system_instructions`。不导出 OpenInference 消息属性。

`updateLlm` 使用完整快照替换语义：`input` 携带消息与可选系统指令，并清理上一请求的输出；`output` 替换当前输出。`undefined` 表示未提供，已知没有候选使用 `[]`，空文本候选保留空 text part。实现层接收更新时立即编码，避免后续对象修改改变已提交数据。新请求绑定使旧 generation 失效，旧回调不能覆盖重试后的消息。

SDK 回调先于 `step-start` 时，适配层暂存结构化快照，待源事件确认 LLM 后提交。成功的 `step-finish` 先于正在等待的 SDK 输出回调时，保留原结束观察时间，待正文回调提交后结束 span；idle、终止错误或关闭负责清理，不无限等待缺失的回调。已取得的结构化输入或输出分别优先于 `startLlm.input`、`finishLlm.output` 的文本降级数据，结束后的更新被忽略。该机制不创建额外 span。

### 7.3 Tool

工具由 `message.part.updated` 中的 tool state 驱动，按所属 interaction、assistant message ID 和 call ID 定位，part ID 仅用于删除关联。`pending` 尚无执行时间，不创建 span；`running` 使用有效的 `time.start` 创建，`completed/error` 使用 `time.end` 结束。缺少 running 时，终态快照提供开始和结束时间，可补建后立即结束。assistant 或 owner 迟到时暂存快照，待能精确关联后记录，不改挂当前 interaction。

`updateTool` 替换参数快照；适配层只在正文开启时复制 JSON 参数和成功输出，实现层序列化参数，并将对象 JSON 结果保留为对象，其余结果编码为 `{ content: output }`。首个终态确定后忽略重复或更旧的状态。已关联的人工拒绝后工具失败分类为 `PermissionRejectedError`，其他执行错误为 `ExecutionError`；失败不报告成功结果。删除、会话终止和关闭清理未完成工具。

### 7.4 Compaction

compaction marker 的 message ID 标识一次压缩，`auto` 取源字段，`overflow` 严格按源字段是否为 true 判断，不由 pending overflow 反推。开始时间优先使用已观察的 marker 用户消息创建时间，否则使用 part 的观察时间。关联优先使用已确认的 overflow 触发 interaction，否则使用 marker owner 或开始时的交互；没有活动任务与可识别 parent 时不补造 run / interaction。

`session.compacted` 结束当前压缩；成功时从已完成摘要 assistant 取得 prompt / summary token 数，标准 usage 同步采用摘要 LLM 的归一化口径，summary token 扩展字段保留不含 reasoning 的输出值。初始化零用量与未完成摘要不当作成功 usage。失败不报告成功用量；新 marker 覆盖旧压缩、摘要出错、marker 删除或会话终止时先清理摘要 LLM，再结束 compaction。重复 marker / 完成事件不重复创建或结束；已关闭压缩不接受新的迟到摘要调用。

摘要 LLM 复用普通 LLM 的 step 生命周期、参数与 AI SDK 消息采集通道，携带对应 `compactionID`。其输入没有 owner 文本降级，避免把用户问题当作摘要请求；没有 SDK 快照时省略未知输入。摘要不成为 interaction 或 run 的最终答复。

### 7.5 Permission

`permission.asked` 只有在 `tool.messageID + tool.callID` 精确对应当前 session 的活动工具时才创建 span；缺少关联或只有 reply 时不补建。接入层兼容 SDK v2 的 `requestID/reply` 与旧声明中的 `permissionID/response` 回复字段，契约只使用 permission 引用及 once / always / reject 决策，不传递源事件。

开始和回复结束使用事件观察时间。人工 reject 是已完成决策，permission span 保持 UNSET，并通过 granted=false 表达；协调模块通知对应工具记录拒绝分类。工具先于 reply 结束时，权限等待以工具终态的观察时间作 ERROR 清理，工具 span 本身仍使用源执行时间。每个 session 最多保留 1024 个待回复请求，超限时 ERROR 结束最旧请求。重复 asked / reply、已结束工具的请求及早于 asked 的孤立 reply 不留下新的等待。

### 7.6 Session 与前台 subagent

`opencode/session.ts` 只保留 session 父关系和活动 task 引用，不查询 OpenCode client。running task 的 `state.metadata.sessionId` 精确指向子 session；`background=true` 不建立前台嵌套关系。协调模块在子 run 开始前传入对应 `ToolReference`，遥测实现验证该 parent 为活动 task 工具，并据此创建同一 trace 下的子 run。所有子 span 使用子 session ID，父 session ID 单独记录。

task 结束时清理尚未结束的子 run，随后释放活动绑定；复用子 session 的下一次任务不会继承旧 task 引用。session 元数据或 task 关联若晚于 run 创建，不事后改写 trace 父节点；无法识别父 task 时仍可记录有业务证据的独立 run，并省略未知关联。关闭按实际父子关系递归清理，避免父 task 在子 run 之前结束。run tracker 始终只接收解析后的输入与明确结果，不重新引入原始 event 分发。

## 8. 验收要求

- 契约模块没有 OpenCode SDK、AI SDK、OTel SDK 或具体实现的依赖。
- run tracker 不依赖源 SDK 或其他对象模块；直接用已识别输入与结束结果验证输入去重、跨会话隔离、旧 run 迟到结束和关闭后的拒绝行为。原始事件及跨对象场景通过 coordinator 验证。
- 适配层可注入记录调用的契约实现，独立验证源事件如何转换为行为；适配测试无需创建 OTel provider。
- 遥测实现可直接接收契约调用，独立验证 span 生命周期、父子关系、属性和导出；实现测试无需构造 OpenCode 事件或 client。
- 通过集成测试覆盖从插件 hook 到 OTLP payload 的完整路径。
- 现有 run 的真实输入、steer、synthetic、overflow 恢复、重复结束及迟到事件行为保持不变。
- interaction 精确关联父 run；验证 steer 时间、assistant 完成时间、空输出与未采集的区别、错误与缺失数据清理、关闭顺序和会话隔离。
- LLM 精确关联父 interaction；验证模型调用证据、step 观察时间、迟到 owner 解析、重试文本隔离、成功用量归一化、字段缺省和 LLM → interaction → run 关闭顺序。
- 消息采集覆盖实际 AI SDK 流到 OTLP 的路径；验证历史消息、系统指令、reasoning、工具及多模态片段、已知空输出、重试替换、事件与回调乱序、跨实例隔离、关联标识移除，以及正文关闭时不解析或保留消息。
- tool 验证终态补建、源时间、迟到 assistant、steer 归属、参数 / 结果编码、错误分类和正文关闭隔离。
- compaction 验证摘要 LLM 的父子关系及正文采集、marker 时间、成功用量、overflow 跨 steer 归属、替换与失败清理。
- permission 验证精确工具关联、人工拒绝与工具错误区分、未回复清理、重复通知和容量淘汰。
- subagent 验证 task → 子 run 的 trace 关联、自身 session 属性、task 绑定释放及关闭时的后代优先顺序。
- 慢导出或导出失败不改变业务行为和时间边界；关闭时能够清理未完成对象，重复关闭不会重复导出。
- 重构完成后通过仓库的格式、lint、类型检查、相关测试和构建。
