# 适配层设计

本文说明 `src/adapter/` 如何根据 OpenCode hooks/events 和 AI SDK 生命周期回调识别行为、采集数据，再通过 Observer 接口提交观测结果。本文还规定如何处理重复通知、迟到数据和事件乱序，以及如何协调多个观测对象。

- [总体架构](architecture.md) 定义模块职责、依赖边界、契约语义和运行约束。
- [Trace Schema：期望规范](schemas/trace.md) 定义目标 trace 结构与 span 属性语义。
- [OpenCode Trace Schema](schemas/trace-opencode.md) 定义当前 span 的创建条件、时间来源、父子关系、导出字段，以及失败或数据缺失时的处理规则。
- 本文定义适配层如何识别和处理源数据。接口与类型见 [Observer 契约](../src/contract/observer.ts)。

## 1. 数据源与证据边界

OpenCode hooks/events 提供用户输入、消息和调用的标识、模型生成步骤（step）、工具执行、上下文压缩和权限决策等信息。适配层据此识别各项操作的开始、更新和结束，再调用对应的 Observer 接口。

普通对话的模型调用和生成压缩摘要的模型调用采用相同的采集规则：通过受支持的 AI SDK 生命周期回调采集模型数据，不要求启用 OpenCode 自身的 AI SDK OTel 导出。未经过 AI SDK 的执行路径使用 OpenCode hooks/events 提供的数据，无法取得的 SDK 字段予以省略。所需依赖版本在 `package.json` 中声明。

`step-start` 和 `step-finish` 是 assistant message 中的 part 类型，通过 `message.part.updated` 事件传递。插件先检查事件的 `type`，再检查 `event.properties.part.type`，以识别模型步骤的开始或完成。它们不是独立的插件事件名，也不同于 AI SDK 的 `onStepStart` / `onStepFinish` 回调。

模型内容和调用生命周期分别由以下数据源提供：

| 信息                         | 当前实现采用的数据源                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| 模型输入、输出正文等内容快照 | AI SDK 回调；缺失时按第 3.3 节使用文本作为降级数据                                                  |
| 调用完成或失败               | assistant 完成消息、`step-finish` 结果，以及错误或终止通知                                          |
| 调用开始时间                 | `llmTimingMode=message` 取 `assistant.time.created`；`fetch` 取首次关联 fetch 调用时间              |
| 调用结束时间                 | `message` 取 `assistant.time.completed`，异常缺失时取终止观察时间；`fetch` 取最后一次响应体结束时间 |
| token 用量和费用             | OpenCode `step-finish` part 中的有效数据                                                            |

SDK 输出回调只负责补充内容，不能单独作为结束 LLM 调用的依据，也不能用回调到达时间或 SDK 用量替换上表规定的数据来源。内容回调与 `step-finish` part 更新的到达顺序不一致时，按第 3.4 节协调提交。

LLM span 默认记录 assistant 消息生命周期，包含请求准备、重试退避、工具执行和清理。fetch 模式取客户端请求与响应体读取边界，缺少完整边界时整组回退至消息口径；两种模式都不代表服务端纯推理耗时。错误或取消时，OpenCode 可能先发送 `session.error` / idle，再写入消息完成时间；消息口径按终止观察时间收尾，不等待未来事件。首块延迟取首次 OpenCode `step-start` 与最终所选 LLM 起点的时间差，不能用首个文本更新替代。重试采集限于 OpenCode 流程，直接使用 retry 通知的 attempt，仅记录次数。具体测量限制和异常规则见 [OpenCode Trace Schema §8](schemas/trace-opencode.md#8-prefixllm)。

`captureContent` 控制正文、LLM 工具定义和工具执行描述的解析、保留和提交。模型请求/响应 HTTP headers（含错误响应）仅在 `captureContent` 和 `captureHttpHeaders` 同时开启时解析、保留和提交；两者默认关闭。关闭正文时，仍可采集 SDK 输出类型（包括确认未配置 `output` 时的默认 `text`）以及技能名称、目录和截断状态；具体约束见 [总体架构 §4](architecture.md#4-观测契约)。上下文传播遵循 [总体架构 §5.2](architecture.md#52-传播边界)。

`part.type=tool` 且 `part.tool=skill` 时，由现有 tool tracker 提交独立的 Skill 契约，不再提交普通 Tool 契约。两类操作共用源时间、消息归属、调用去重、权限拒绝和提前结束处理；无额外 skill tracker 或宿主 hook。技能名称直接白名单读取 `state.input.name`，成功快照中的 `state.metadata.name` 优先确认或补充；成功 metadata 还可提供目录和截断标记。完整参数不保留，实际返回文本仅在正文开启且成功时提交，不额外读取技能文件。

## 2. 用户输入识别与去重

适配层需要区分真实用户输入、系统生成的续接文本（synthetic）和用于标记压缩的消息。压缩摘要不计入 run 或 interaction 的用户输入，也不作为最终答复。含有多种内容的消息如何识别和记录，见 [OpenCode Trace Schema §5–6](schemas/trace-opencode.md#5-prefixrun)。

适配层以 session ID 和 message ID 的组合作为用户消息的去重标识。同一条消息在插件实例的生命周期内只登记一次；在记录输入、创建 interaction 或开启 run 之前，必须先检查是否已经处理过该消息。

任务执行期间收到的追加输入（steer）由 interaction 跟踪逻辑处理，协调模块统一安排消息归属和最终答复的选择。新输入产生新的 interaction 后，已有的 LLM 和工具调用仍属于原先确认的 interaction。交互切换时的结束时间和输出规则见 [OpenCode Trace Schema §6.2](schemas/trace-opencode.md#62-生命周期)。

## 3. LLM 关联与采集

### 3.1 生命周期证据归并

调用 `startLlm` 前，适配层必须同时确认以下信息：

- 已观察到请求准备或 `step-start` part 更新。
- 已确定该调用对应的 assistant message，并取得有效的 `time.created`。
- 已确定该调用所属的 interaction；摘要调用还需关联到对应的 compaction。

适配层优先在 `chat.headers` 请求准备阶段完成关联，以便在请求发出前传播 trace 上下文。该 hook 和 `step-start` 只提供调用开始证据，初始 span 开始时间使用 assistant 的 `time.created`；fetch 模式在收尾时提交实际观察的 transport 边界，供遥测层校准导出时间。消息元数据稍后到达时暂存证据，待消息与归属确定后补交开始。只有 assistant message 或完成通知，而没有调用开始证据时，不创建 LLM 观测记录。

同一 assistant message 对应的 step 和重试归入同一个逻辑 LLM 调用。进入新的 step 时更新当前快照，清除前一步遗留的数据；同一 step 的重复通知不清空快照，旧尝试的迟到内容也不能覆盖新结果。观察到 step part 更新的时间不代表精确的网络请求或重试起点。

首块近似计时独立于 SDK 回调和内容快照：首次 `step-start` 优先使用事件携带的有效发布时间，缺失时使用接收时间。tracker 通过 `LlmUpdate.firstChunkObservedAt` 提交该时间戳，消息归属尚未确定时暂存；telemetry 在收尾选定 message/fetch 起点后计算差值并换算为秒。fetch 边界回退到消息时，首块耗时同步回退。SDK 绑定和重试不影响首次终点，重复和后续 step 不替换它；没有首次 step、差值无效或为负、调用已结束时不补造数据。完整口径见 [OpenCode Trace Schema §8.1](schemas/trace-opencode.md#81-身份模型和用量)。

`session.status` 由 coordinator 转交 LLM tracker。tracker 仅处理 retry，将通知绑定到唯一活动 assistant；有效正整数 `attempt` 大于已记录次数时，直接更新并通过 `LlmUpdate.retryCount` 提交。重复或较旧序号、归属未知或歧义的通知均忽略。tracker 只保存次数，不维护待重试状态，也不依赖 busy；退避期间终止仍保留已记录次数。计数独立于 SDK 内容快照保存，摘要调用同样采集，不依赖正文或计时模式开关。适配层不读取、保存或提交 retry 的原因、预计时间及观察时间；遥测层仅导出次数，不自行推断重试。

用量只从有效的完成数据中读取，不把消息初始化时的零值当作已经完成的用量统计。用量归一化规则见 [OpenCode Trace Schema §8.1](schemas/trace-opencode.md#81-身份模型和用量)。

### 3.2 请求绑定与实例隔离

适配层在同一 session 内，结合请求对应的用户消息、provider、model 和 agent 等信息查找模型调用。只有匹配结果唯一、且调用的父对象已确定时，才通过一次性关联标识将该请求与后续 SDK 回调绑定。后续回调还须校验调用身份和绑定是否仍然有效，不能只根据 session ID 决定数据归属。

用于生成会话标题的模型调用、无法唯一匹配的调用，以及无法关联到父对象的摘要调用，都不采集 SDK 数据。

内部关联标识在 provider 执行前移除，不通过 Observer 接口提交，也不写入 span。SDK 回调在进程内统一注册，但每个插件实例只处理与自身绑定的调用。实例释放时，移除该实例的监听器，并使旧绑定失效；尚未完成的异步设置解析也必须通过绑定有效性检查后才能提交。共享回调中的失败隔离要求见 [总体架构 §6.1](architecture.md#61-执行与失败隔离)。

fetch 计时与 SDK 正文绑定独立：仅在 `llmTimingMode=fetch` 时安装进程级 fetch 包装器，coordinator 将 `chat.headers` 取得的活动 span traceparent 与 LLM tracker 的时间回调绑定。包装器不读取或替换 provider 配置、鉴权 fetch，不改写请求，只匹配已登记的 traceparent；其他请求透传。多实例共用包装器，最后一个监听器退出后恢复原 fetch；若另一个插件随后替换了 fetch，不覆盖它的实现。

响应体通过单条 pull/cancel 链路逐块透传，不 clone、解码、缓存或另行 drain。开始取调用底层 fetch 前的时间；正常结束取响应体 EOF，无 body 取响应返回时间，异常或取消取对应观察时间。EOF 不等于模型协议成功，取消也可能由 SDK 主动结束读取引起；LLM 状态仍由 SDK/OpenCode 结果确定。原错误与取消原因传回宿主，观测失败单独隔离。

tracker 保存首次 fetch 开始、最后一次结束、在途请求集合和最新准备阶段。重试不重置起点；任一已观察的准备阶段没有对应 fetch、存在未结束 body 或时间无效时整组回退，不能将旧请求终点冒充新请求终点，也不能用后一次请求补造首次起点。收尾通过 `LlmFinish.timing` 提交所选边界或回退原因。完成记录不接受迟到请求回调。预先绑定其他 fetch、独立 transport、被替换的 traceparent 等不保证可见；覆盖范围仅限穿过包装器的已关联调用。

### 3.3 数据转换与快照提交

适配层将当前 step 的 SDK 消息、请求参数、工具定义及 headers 转换为 Observer 契约定义的数据快照。输入和输出独立选择数据来源：各自优先使用 SDK 结构化快照，缺失时再使用对应的文本作为降级数据。例如，已取得结构化输入，并不意味着一定能取得结构化输出。

消息来源、生成内容的范围、转换规则，以及 SDK 可见 headers 的限制，见 [OpenCode Trace Schema §8.2–8.3](schemas/trace-opencode.md#82-消息与系统指令)。GenAI/HTTP 属性的编码由遥测层完成。

请求信息、输入、输出、响应模型和响应 headers 通过 [LlmUpdate](../src/contract/observer.ts) 提交。响应模型直接取 `onStepFinish` 的 `event.response.modelId`，不受 `captureContent` 控制，保留 SDK 自身可能采用的请求模型兜底；插件不另行补值。新请求快照清除前一次输出、响应模型和响应 headers，新输入快照清除前一次输出。未取得数据与已确认结果为空必须区分，例如 `output: []` 表示已确认空响应，不能用来表示未采集输出。

AI SDK 的 `event.output.responseFormat` 是 PromiseLike，工具的 `asSchema(tool.inputSchema).jsonSchema` 也可能返回 PromiseLike。因此，采集输出类型（`text` / `json`）和工具参数的 JSON Schema 时，可能需要等待这些值就绪。适配层先提交已取得的快照，再异步补充这些字段，不在 SDK 回调中等待采集完成。某个字段读取或转换失败时，仅对该字段降级处理。

当 SDK 回调中的 `event.output` 为 `undefined` 时，按 AI SDK 默认文本生成行为，在初始快照中同步记录输出类型 `text`，不等待工具 schema。已配置的输出格式尚未就绪、解析失败或无法识别时省略类型；没有 SDK 回调时也不补默认值。

异步结果只能补充仍在等待响应的当前 step：新绑定或新 step 建立后，旧结果失效；响应已到达、绑定已失效、调用已结束或实例已关闭时，也忽略尚未提交的结果。已收到的响应应及时提交，不等待上述字段的采集完成。

### 3.4 开始与结束事件的乱序

SDK 快照先于调用开始证据到达时，可以先暂存，待满足第 3.1 节的创建条件后再提交。`step-finish` 保存结果，assistant 完成更新保存结束时间，两者独立到达。只有结果和有效的 `time.completed` 均已取得，且等待中的 SDK 输出已经提交，才正常调用 `finishLlm`；错误或强制收尾不等待内容回调。

例如，在 T1 收到 `step-finish`，T2 收到 assistant 更新（携带 `time.completed=T0`），T3 收到 SDK 输出，则在 T3 补齐内容并提交结束，message 模式的 span 结束时间仍为 T0；fetch 模式使用之前保存的响应体结束时间。完成消息先于 step 结果到达时同样保留源时间，避免提前丢弃用量。

session 进入 idle、发生终止错误、消息删除、compaction 收尾或插件实例关闭时，必须清理仍在等待的调用，不能无限等待 SDK 输出回调。已有消息完成时间的调用保留该时间与已知结果，缺失内容或 step 用量时省略相应字段；没有有效完成时间的调用按终止观察时间和错误收尾。已结束记录不因迟到的完成消息而改写。

## 4. 跨对象协调

工具执行描述在 `onStepStart` 中同步取得当前有效工具的描述快照，不等待异步参数 schema。`onToolCallStart` 校验相同绑定和 step 后，按工具名称取描述并带上调用 ID；LLM tracker 提供绑定的 run 和 assistant message 身份，coordinator 将该数据交给 tool tracker。SDK 回调不创建或结束工具观测，生命周期仍由 OpenCode tool part 决定。

描述可先于 tool part 到达，tool tracker 在 run 内按 message ID / call ID 暂存最多 1024 条描述，超过上限淘汰最早记录；part 到达后还须校验工具名称。已开始的工具可补交描述，首次已确认描述保留，已结束调用拒绝迟到描述。暂存记录在关联、消息删除或 run 释放时清理；不保留完整工具定义，也不跨 run 猜测同名工具的描述。技能加载使用独立 Skill 契约，不提交普通工具描述。

协调模块负责确定观测对象之间的归属关系，在相关对象之间传递结果，并安排清理顺序。例如，权限拒绝结果需要传递给对应工具，task 工具结束时需要清理关联的子 run。coordinator 主动调用各 tracker 的查询方法，把解析后的 interaction 归属、活动工具或 agent 身份信息作为数据传入目标 tracker，不注入其他 tracker 的解析方法。tracker 不感知 user ID，span 的用户身份由初始化时的 `spanAttributes` 统一提供。生命周期通知由协调模块连接，模块依赖遵循 [总体架构 §2.3](architecture.md#23-各层内部组织)。

LLM、tool（含 skill.load）和 compaction 的开始证据可以先到达。对应 tracker 暂存自身数据，并通过 `unresolved(run)` 返回所需的消息或压缩标识及时间；coordinator 在消息和压缩证据更新后重新解析归属，通过 `associate` 提交结果。解析不成功时继续等待，保留原始开始、结束时间；对象已开始或结束后，迟到的解析结果不能改变已提交的父子关系。模型请求准备和 SDK 绑定前也由 coordinator 补齐可解析的归属。

权限请求可能先于工具 running part 到达，skill 加载尤其容易出现这种顺序。permission tracker 在同一 run 的有界 pending map 中暂存必要请求字段和首次答复，不保存原始请求对象；coordinator 在 tool tracker 的开始通知中按 message ID / call ID 关联，补交权限操作并回传拒绝结果。只有创建工具或技能加载观测后才创建权限观测，不猜测 parent；收尾或淘汰时仍无法关联的请求省略。reply 先于 asked 时不补造请求。

### 4.1 归属解析

| 父对象 → 子对象                      | 适配层如何确定关联                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| run → interaction                    | 根据真实用户消息创建 interaction，并确定该消息属于哪个 run                                                                                   |
| interaction → tool / skill.load      | 通过工具所属的 assistant message 找到对应的用户消息，再确定 interaction；使用 message ID 和 call ID 区分调用                                 |
| interaction → compaction             | 上下文溢出（overflow）触发的压缩优先关联到发生溢出的模型调用所属的 interaction；自动压缩则根据标记该压缩动作的源事件或 hook 确定 interaction |
| compaction → 摘要 LLM                | 根据摘要调用对应的压缩标记，找到所属的 compaction                                                                                            |
| tool / skill.load → permission.check | 根据权限请求中的 message ID 和 call ID，在同一 run 内精确匹配调用；请求先到时等待调用开始和归属证据                                          |
| task 工具 → 子 run                   | 在子 run 创建前，确认活动 task 工具与子 session 的对应关系；后台任务不建立这种前台父子关系                                                   |

父子关系一旦通过 Observer 提交，后续事件不能改变该关系。无法确定父对象时，按 [OpenCode Trace Schema](schemas/trace-opencode.md#3-trace-拓扑) 中对应对象的规则省略记录，或将 run 记录为独立根节点，不猜测父子关系。

### 4.2 状态联动

协调模块根据 OpenCode 事件判断上下文溢出是否可以恢复。恢复期间，run 和 interaction 保持未结束状态；只有确认错误导致任务终止时，才以失败结果结束它们。interaction 内发生的局部错误不直接等同于 run 失败，子对象失败也不自动使父对象失败。

用户拒绝权限请求，表示权限检查已经得到答复，因此检查流程正常结束。协调模块将拒绝结果通知对应工具；该工具随后若因拒绝而失败，则使用权限拒绝的错误分类。各对象的结束状态和错误分类见 [OpenCode Trace Schema §12](schemas/trace-opencode.md#12-状态与错误汇总)。

## 5. 迟到数据与清理

如果工具 part 更新已经到达，但确定其归属所需的消息元数据尚未到达，可以先暂存工具数据。即使未观察到工具的 `running` 状态，只要后续 part 更新中的完成或失败状态包含有效的开始、结束时间，且能够确定工具归属，也可以按 [OpenCode Trace Schema §9.2](schemas/trace-opencode.md#92-生命周期与状态) 补交开始和结束操作。首次确认完成或失败后，忽略随后到达的旧状态和重复通知。

工具完成、删除和 run 收尾共用结束登记路径，在生命周期回调和 Observer 提交前移除活动记录并登记结束标识。删除和 run 收尾也结束尚未取得归属的暂存工具；此时不提交工具观测或生命周期回调，后续归属补齐和旧 part 均不能重建该工具。仅收到完成快照但仍等待归属的工具继续暂存，直到关联或收尾。

去重记录只保存必要标识，不保存正文。用户输入的去重记录跨 run 保留到实例关闭，防止旧输入再次到达而开启新的 run。LLM、tool、permission 和 compaction 的去重及结束标记只保留到所属 run 释放。已结束的 interaction 和 compaction 还需保留用于归属查询的必要上下文，直到所属 run 收尾完成，以便处理归属已明确但事件迟到的操作。仅携带 session ID 的迟到源事件仍须通过消息归属和去重判断，不能将当前活动 run 的引用当作事件归属的充分证据。

待回复的权限请求数量必须设有上限。因容量限制而移除已开始的权限检查时，必须提交结束结果；未取得调用归属的请求直接丢弃；结束状态遵循 [OpenCode Trace Schema §11.2](schemas/trace-opencode.md#112-生命周期与状态)。工具结束时，清理其尚未收到答复的权限请求。task 工具结束时，先清理关联的子 run，再释放工具与子 session 的绑定，避免后续任务误用旧关联。

各对象的数据生命周期如下：

| 所属模块            | 数据                                       | 释放时机                                                                                                          |
| ------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| run tracker         | 活动 run 引用                              | run 结束；收尾异常时也释放引用                                                                                    |
| run tracker         | 已处理用户输入标识                         | 实例生命周期内保留，不主动清理                                                                                    |
| interaction tracker | 输入、消息归属、assistant 元数据和文本     | 所属 run 收尾完成后统一释放；steer 不释放旧交互的归属上下文                                                       |
| LLM tracker         | 调用、正文、请求快照、绑定身份             | 已提交结束的调用立即移除；未匹配请求及其他暂存记录在 run 释放时移除                                               |
| LLM tracker         | 已结束调用与压缩标记                       | 所属 run 释放                                                                                                     |
| tool tracker        | 活动工具、技能加载及等待归属的 part        | 已确认结束的调用立即移除；未能关联的 part 也在 run 释放时移除                                                     |
| tool tracker        | 已结束工具及技能加载标识                   | 所属 run 释放                                                                                                     |
| permission tracker  | 待关联或待答复请求及先到的首次答复         | 关联后完成、调用结束、容量淘汰或 run 结束时移除；已开始的观测先提交结束，未关联的不创建 span；容量限制按 run 计算 |
| permission tracker  | 已处理请求标识                             | 所属 run 释放                                                                                                     |
| compaction tracker  | 当前压缩、用户时间及已结束压缩上下文       | 所属 run 收尾完成后统一释放                                                                                       |
| coordinator         | 活动 run 路由、父工具、overflow 和 trigger | 开始结束流程时移出活动路由，收尾结束后释放局部引用                                                                |
| session registry    | session 父子元数据                         | session 删除；session idle 时保留                                                                                 |
| session registry    | task 工具与子 session 的绑定               | 对应子 run 收尾后、task 工具结束时释放；所属父 run 清理时兜底释放                                                 |

run 结束时，coordinator 先从活动路由移除该 run，再递归结束关联子 run，依次收尾 permission、LLM、compaction、tool（含 skill.load）、interaction 和 run。各 tracker 的分区在这一阶段仍可供内部查询；最终清理路径调用 `release(run)` 删除完整分区，包括未创建观测对象的暂存数据，即使观测提交抛错也执行释放。释放一个 run 不影响其他分区，重复释放无副作用。

LLM 的 SDK 回调只捕获 run 引用、message ID 和绑定身份，每次回调重新查询对应分区和调用，不捕获调用记录及正文快照。重新绑定、调用移除或 run 释放后，旧回调失效且不会重新创建分区。

数据清理只覆盖运行期间的对象、run 和 session 生命周期，不为程序停止设计额外的数据清理流程。tracker 没有 `dispose()` 接口；实例剩余数据由垃圾回收处理。宿主关闭时仍注销监听器、停止采集并完成遥测导出，见 [总体架构 §6.2](architecture.md#62-生命周期契约)。
