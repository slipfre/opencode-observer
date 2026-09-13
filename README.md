# opencode-observer

OpenCode 可观测性插件，记录任务、用户交互、模型调用、工具执行、上下文压缩和权限检查，通过 OTLP HTTP/JSON 导出到遥测接收端。使用 TypeScript 开发，通过 Bun 构建。

目前支持 run、interaction、LLM、tool、compaction 和 permission.check 六类 span，可记录父子关系、token 用量、错误，以及按需开启的输入输出正文。

Resource 默认上报 `service.name=opencode`，`service.version` 来自运行中 OpenCode 的健康接口；无法获取版本时省略。Instrumentation scope 的 `name` 和 `version` 来自插件的 `package.json`。

## 安装与启用

在 OpenCode 的 `opencode.json` 中配置插件包和支持 OTLP HTTP/JSON 的遥测接收端：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-observer",
      {
        "enabled": true,
        "endpoint": "http://localhost:4318",
        "captureContent": true
      }
    ]
  ]
}
```

接收端默认地址为 `http://localhost:4318`，请按实际部署修改。

## 配置

也可以通过环境变量配置。插件选项优先于对应环境变量；遥测和正文采集默认关闭。上面的示例同时开启两者。

| 插件选项                  | 环境变量                              | 默认值 / 格式                                                        |
| ------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `enabled`                 | `OPENCODE_ENABLE_TELEMETRY`           | `false`；布尔环境变量接受 `true` / `false` / `1` / `0`               |
| `captureContent`          | `OPENCODE_CAPTURE_CONTENT`            | `false`；控制输入和输出正文                                          |
| `endpoint`                | `OPENCODE_OTLP_ENDPOINT`              | `http://localhost:4318`；自动补齐 `/v1/traces`                       |
| `tracePrefix`             | `OPENCODE_TRACE_PREFIX`               | `opencode.`                                                          |
| `otlpHeaders`             | `OPENCODE_OTLP_HEADERS`               | 选项使用字符串值对象；环境变量使用 `key=value,key2=value2`           |
| `resourceAttributes`      | `OPENCODE_RESOURCE_ATTRIBUTES`        | 同上，可覆盖默认 resource 属性                                       |
| `spanAttributes`          | `OPENCODE_SPAN_ATTRIBUTES`            | 同上；支持 `user.id`，不能覆盖其他插件身份、标准操作、正文和错误字段 |
| `spanAttributeCountLimit` | `OPENCODE_SPAN_ATTRIBUTE_COUNT_LIMIT` | `4096`，正整数                                                       |

### 用户身份解析

启用遥测后，可通过以下独立环境变量配置身份查询及模型请求中的身份传播。入口调用独立 user 模块读取配置并查询身份，等待查询结束后，将有效的 `user.id` 合并到 `spanAttributes` 再创建 telemetry，并把查询结果和开关快照传给 adapter。身份接口不使用插件选项，也不读取 OpenCode provider 配置。

| 环境变量                           | 默认值 / 格式                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `OPENCODE_USER_ID_ENABLED`         | `true`；`false` / `0` 同时关闭身份查询和 tracestate 中的身份写入                            |
| `OPENCODE_USER_ID_ENDPOINT`        | 未设置；需要完整 HTTP(S) 身份接口地址，例如 `https://identity.example.com/queryUserByToken` |
| `OPENCODE_USER_ID_TOKEN`           | 未设置；身份接口接受的 token，可配置为对应 provider 的 API key                              |
| `OPENCODE_USER_ID_X-Blackbox-Auth` | 未设置；可选的 `X-Blackbox-Auth` 请求头                                                     |
| `OPENCODE_USER_ID_TIMEOUT`         | `3000` 毫秒，正整数                                                                         |
| `OPENCODE_USER_ID_RETRY_COUNT`     | `2`；首次失败后的重试次数，允许 0～10                                                       |

未启用遥测、身份查询关闭、接口地址缺失或无效、token 为空时，不发送查询请求。数值配置无效时使用默认值。

插件向身份接口 POST JSON `{"token":"..."}`，仅接受 `code: 0` 且 `result.ssicNo` 为有效非空字符串的响应。token 和返回的 ID 会去除首尾空格，`unknown` 不视为有效 ID。token 和鉴权请求头仅用于身份查询，不写入 span。

初始化会等待查询及重试完成，失败时按 250、500、1000 毫秒等指数退避重试；默认最多请求三次，每次超时 3 秒。查询失败后继续启动。此过程可能延长插件初始化；初始化后不再后台查询或冷却重试。

查询成功的 ID 优先于选项或环境变量 `spanAttributes` 中的 `user.id`；查询及重试最终失败时保留静态配置，没有静态配置则写入 `user.id=unknown`，表示未取得有效身份。因开关关闭、地址无效或 token 为空而未发起查询时，保留静态配置，没有静态配置则省略。六类 span 从创建起使用这份配置快照，正文采集关闭时仍生效。契约显式提供的非空身份优先于配置值和 `unknown` 兜底值。修改 token 或环境变量需要重新初始化插件才会生效。

同一个开关开启时，adapter 在可关联的模型请求中将动态查询结果写为 `tracestate: user_id=<ID>`。未配置有效地址或 token、未取得有效 ID、查询失败时均发送 `user_id=unknown`，不使用静态 span 属性替代动态查询结果。已有厂商项保留顺序，已有 `user_id` 被替换并移至首位，超过 32 项时移除末尾项。W3C key 不允许点号，因此使用 `user_id`；ID 去除首尾空白后须为不含逗号或等号的 1～256 个可打印 ASCII 字符，无法合法表示时也使用 `unknown`。该逻辑全部位于 adapter，只修改出站 headers，不修改 OTel SpanContext 或 OTLP 的 traceState。关闭此开关不影响 traceparent 传播。

## 采集范围与限制

- 一个 run 表示一次任务执行，包含一次或多次用户交互。任务执行中的追加输入（steer）会创建新 interaction；run 和 interaction 的正文仅聚合真实用户文本和最终答复。
- 开启正文采集后，模型消息可包含历史上下文、系统指令、reasoning、工具调用与结果、多模态内容，工具 span 可记录参数与成功结果。模型正文反映 SDK 可见的内容，后续 provider 转换仍可能改变实际请求。开启 `OPENCODE_EXPERIMENTAL_NATIVE_LLM` 或无法取得完整消息时，普通模型调用降级为所属用户文本和可见答复，摘要调用省略未知输入。
- 可唯一关联的模型请求在 `chat.headers` 阶段创建 LLM span，并注入该 span 的 W3C `traceparent`；非空 `tracestate` 及启用的身份字段一并传播，不依赖正文采集开关。AI SDK 路径支持端到端传播；当前 OpenCode native HTTP 层会覆盖准备好的 traceparent，因此 native 路径尚不能保证与本插件 trace 关联。标题、归属未知或歧义的调用省略注入；不读取外部 trace 上下文配置。
- LLM 耗时从请求准备阶段的观察时间开始，未取得请求关联时降级为首个 `step-start` 的观察时间，结束仍使用事件观察边界，可能包含请求准备、事件处理和工具等待开销；当前未精确测量网络请求耗时或首 chunk 耗时。重试字段的 `0` / `[]` 表示尚未确认重试开始，不能据此判断没有重试。
- 前台子任务的父子关联和权限检查 span 依赖可识别的工具关联；未知关联不会补造。暂不采集工具定义、HTTP headers 或真实响应 ID/model。

正常完成的 span 状态为 `UNSET`，失败为 `ERROR`。缺失数据省略，正文未采集与明确为空有不同含义。完整字段、父子关系及生命周期约定见 [Trace Schema](docs/schemas/trace.md)。

## 开发与测试

需要 Bun 1.3.14 或更新版本。在仓库根目录安装依赖后执行检查和测试：

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run test:e2e
```

`check` 包含格式、lint 和类型检查；`test` 运行单元及进程内集成测试。`test:e2e` 重新构建插件，启动真实 OpenCode CLI 和本地模拟服务，无需模型 API key 或外部遥测接收端。

E2E 需要提前准备已安装依赖的 OpenCode 源码，并通过 `OPENCODE_E2E_ENTRY` 指定其 `packages/opencode/src/index.ts` 入口。完整命令、运行条件和排障说明见 [AGENTS.md](AGENTS.md#testing-and-verification)。

## 开发文档

项目采用 OpenCode 适配层、观测契约层和遥测实现层三层结构，通过契约连接行为识别与 trace 导出。

- [AGENTS.md](AGENTS.md)：项目目标、主要目录、构建测试方法和开发约束。
- [架构实现 Spec](docs/spec.md)：模块职责、依赖方向、事件处理和内部实现。
- [Trace Schema](docs/schemas/trace.md)：trace 拓扑、字段语义、生命周期和异常处理规则。

## 协议

[MIT](LICENSE)
