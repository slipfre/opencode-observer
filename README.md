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

## 采集范围与限制

- 一个 run 表示一次任务执行，包含一次或多次用户交互。任务执行中的追加输入（steer）会创建新 interaction；run 和 interaction 的正文仅聚合真实用户文本和最终答复。
- 开启正文采集后，模型消息可包含历史上下文、系统指令、reasoning、工具调用与结果、多模态内容，工具 span 可记录参数与成功结果。模型正文反映 SDK 可见的内容，后续 provider 转换仍可能改变实际请求。开启 `OPENCODE_EXPERIMENTAL_NATIVE_LLM` 或无法取得完整消息时，普通模型调用降级为所属用户文本和可见答复，摘要调用省略未知输入。
- LLM 耗时使用事件观察边界，可能包含事件处理和工具等待开销；当前未精确测量模型请求耗时或首 chunk 耗时。重试字段的 `0` / `[]` 表示尚未确认重试开始，不能据此判断没有重试。
- 前台子任务的父子关联和权限检查 span 依赖可识别的工具关联；未知关联不会补造。暂不采集工具定义、HTTP headers 或真实响应 ID/model，也未启用用户 ID 解析。

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
