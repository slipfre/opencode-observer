# opencode-observer

OpenCode 可观测性插件，记录任务执行、用户交互、模型调用、工具执行、技能加载、上下文压缩和权限检查，通过 OTLP 导出到遥测接收端，默认使用 HTTP/JSON，也支持 HTTP/Protobuf 和 gRPC，便于查看执行过程、耗时、token 用量和错误。

支持按需采集输入输出正文、工具定义及模型 HTTP 请求／响应头。遥测和正文采集默认关闭。

## 安装与使用

支持 npm 包和单文件 JS 两种安装方式，两者均支持 OTLP HTTP/JSON、HTTP/Protobuf 和 gRPC。准备遥测接收端后，选择与接收端匹配的导出协议和地址，具体见 [OTLP 协议](#otlp-协议)。

### npm 包

在 OpenCode 的 `opencode.json` 中添加插件，以下以默认的 HTTP/JSON 协议为例：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-observer",
      {
        "enabled": true,
        "otlpProtocol": "http/json",
        "endpoint": "http://localhost:4318",
        "captureContent": true
      }
    ]
  ]
}
```

根据接收端设置 `otlpProtocol`（`http/json`、`http/protobuf` 或 `grpc`）和 `endpoint`。例如使用 gRPC 时，将协议设为 `grpc`，地址通常为 `http://localhost:4317`。启动 OpenCode 并执行任务后，即可在接收端查看 trace；默认服务名称为 `opencode`。

上述示例同时开启遥测和正文采集。只需耗时、token 用量和错误等信息时，可移除 `captureContent` 或将其设为 `false`。

### 单文件 JS

使用独立构建产物 `dist/standalone/opencode-observer.js`，该文件包含插件运行所需的第三方依赖，由 OpenCode 的 Bun 运行时加载，无需为插件单独安装 npm 依赖。

从源码构建时，在本仓库根目录运行：

```sh
bun install --frozen-lockfile
bun run build:standalone
```

将生成的 `opencode-observer.js` 复制到以下任意一个位置：

| 作用范围 | 文件位置                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| 当前项目 | `<项目目录>/.opencode/plugins/opencode-observer.js`                                                            |
| 当前用户 | `~/.config/opencode/plugins/opencode-observer.js`（设置了 `XDG_CONFIG_HOME` 时使用其下的 `opencode/plugins/`） |

OpenCode 自动发现该文件，无需在 `opencode.json` 中再声明插件。通过环境变量设置与接收端匹配的协议和地址后启动 OpenCode，以下以 HTTP/JSON 为例：

```sh
export OPENCODE_ENABLE_TELEMETRY=true
export OPENCODE_OTLP_PROTOCOL=http/json
export OPENCODE_OTLP_ENDPOINT=http://localhost:4318
opencode
```

正文采集默认关闭，需要时设置 `OPENCODE_CAPTURE_CONTENT=true`。其他配置同样使用下表中的环境变量。升级时替换同一路径下的 JS 文件并重启 OpenCode；回退时换回旧版本文件。

不要同时保留 npm 安装、项目级文件和用户级文件等多个副本，以免重复采集。`dist/index.js` 是 npm 包入口，依赖外部包，不能替代上述独立构建文件。

## 配置

支持插件选项和环境变量，插件选项优先于对应环境变量。布尔环境变量接受 `true` / `false` / `1` / `0`。

| 插件选项                   | 环境变量                              | 默认值      | 说明                                                                           |
| -------------------------- | ------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| `enabled`                  | `OPENCODE_ENABLE_TELEMETRY`           | `false`     | 开启遥测                                                                       |
| `captureContent`           | `OPENCODE_CAPTURE_CONTENT`            | `false`     | 采集输入输出正文、LLM 工具定义和工具执行描述                                   |
| `captureHttpHeaders`       | `OPENCODE_CAPTURE_HTTP_HEADERS`       | `false`     | 采集模型请求／响应头，需同时开启 `captureContent`                              |
| `llmTimingMode`            | `OPENCODE_LLM_TIMING_MODE`            | `message`   | `message` 按模型消息创建到完成计时；`fetch` 按模型请求开始到响应体读取结束计时 |
| `otlpProtocol`             | `OPENCODE_OTLP_PROTOCOL`              | `http/json` | 导出协议：`http/json`、`http/protobuf` 或 `grpc`                               |
| `endpoint`                 | `OPENCODE_OTLP_ENDPOINT`              | 按协议选择  | HTTP(S) 接收端地址，HTTP 协议自动补齐 `/v1/traces`                             |
| `tracePrefix`              | `OPENCODE_TRACE_PREFIX`               | `opencode.` | span 名称前缀                                                                  |
| `attributePrefix`          | `OPENCODE_ATTRIBUTE_PREFIX`           | `opencode.` | 插件生成的内建 `opencode.*` span 属性键前缀                                    |
| `otlpHeaders`              | `OPENCODE_OTLP_HEADERS`               | 空          | 发往遥测接收端的请求头，例如鉴权信息                                           |
| `otlpTimeoutMillis`        | `OPENCODE_OTLP_TIMEOUT`               | `10000`     | 单批 OTLP 发送与重试的时间预算，单位毫秒                                       |
| `batchExportTimeoutMillis` | `OPENCODE_BATCH_EXPORT_TIMEOUT`       | `30000`     | 批处理器等待单批导出完成的上限，单位毫秒                                       |
| `forceFlushTimeoutMillis`  | `OPENCODE_FORCE_FLUSH_TIMEOUT`        | `30000`     | 主动刷新等待完成的上限，单位毫秒                                               |
| `resourceAttributes`       | `OPENCODE_RESOURCE_ATTRIBUTES`        | 空          | 自定义 resource 属性，可覆盖默认服务名称等属性                                 |
| `spanAttributes`           | `OPENCODE_SPAN_ATTRIBUTES`            | 空          | 自定义 span 属性；受保护的内建字段不可覆盖                                     |
| `spanAttributeCountLimit`  | `OPENCODE_SPAN_ATTRIBUTE_COUNT_LIMIT` | `4096`      | 每个 span 的属性数量上限，必须为正整数                                         |

`llmTimingMode` 同时决定首块耗时的计时起点。`fetch` 模式包含中间重试等待，无法取得完整计时数据时回退到 `message`。这些耗时可能包含本地处理或重试等待，不代表服务端纯推理时间；首块耗时也不是网络首字节耗时。

`attributePrefix` 与 `tracePrefix` 独立配置，未配置时各自使用 `opencode.`，不会互相继承。例如 `tracePrefix: "agent."`、`attributePrefix: "app."` 会生成 `agent.llm` span，并将内建 `opencode.message.id` 写为 `app.message.id`。两项均按字符串原样拼接，不自动补 `.`；空字符串表示移除对应前缀。

属性前缀只作用于插件生成的内建 `opencode.*` span 属性键，标准字段及 `ai.agent.skill.name` 保持原名。显式配置的 `spanAttributes`、`resourceAttributes` 和属性值不做重命名；`spanAttributes` 仍不能注入默认前缀或配置前缀下受保护的内建字段，也不能绕过正文采集开关。其他自定义键（例如 `opencode.custom.tag`）原样保留。内建字段只导出配置后的键名，不额外保留默认键名。

### OTLP 协议

`otlpProtocol` 默认值为 `http/json`，保留原有导出行为。可选值沿用 [OpenTelemetry 协议标识](https://opentelemetry.io/docs/specs/otel/protocol/exporter/)：

| `otlpProtocol`  | 传输格式               | 默认 `endpoint`         |
| --------------- | ---------------------- | ----------------------- |
| `http/json`     | HTTP + JSON            | `http://localhost:4318` |
| `http/protobuf` | HTTP + 二进制 Protobuf | `http://localhost:4318` |
| `grpc`          | gRPC + 二进制 Protobuf | `http://localhost:4317` |

HTTP 协议会在地址路径末尾补齐 `/v1/traces`，已有该后缀时不重复追加。gRPC 地址使用 `http://`（明文）或 `https://`（TLS），不能包含业务路径、查询参数或片段，也不追加 `/v1/traces`。显式配置的地址和端口优先，不会随协议自动改写。

例如，使用 HTTP/Protobuf 时，在插件选项中设置 `"otlpProtocol": "http/protobuf"`，或设置环境变量 `OPENCODE_OTLP_PROTOCOL=http/protobuf`。插件选项优先于环境变量；不读取 `OTEL_EXPORTER_OTLP_PROTOCOL` 或 `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`。遥测开启时，不支持的协议值会报配置错误。

`otlpHeaders` 在 HTTP 协议中作为请求头，在 gRPC 中作为 metadata 传递。

### 使用环境变量

使用 npm 安装时，在 `opencode.json` 中只声明插件；使用单文件 JS 自动加载时跳过此步骤：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-observer"]
}
```

在启动 OpenCode 的终端中设置环境变量，协议和地址需与接收端匹配，以下以 HTTP/JSON 为例：

```sh
export OPENCODE_ENABLE_TELEMETRY=true
export OPENCODE_OTLP_PROTOCOL=http/json
export OPENCODE_OTLP_ENDPOINT=http://localhost:4318
export OPENCODE_CAPTURE_CONTENT=true
opencode
```

### 请求头与自定义属性

`otlpHeaders`、`resourceAttributes` 和 `spanAttributes` 在插件选项中使用字符串值对象，例如：

```json
{
  "otlpHeaders": {
    "Authorization": "Bearer <collector-token>"
  },
  "resourceAttributes": {
    "service.name": "my-opencode"
  },
  "spanAttributes": {
    "team.name": "platform"
  }
}
```

将这些字段放入插件选项对象中。通过环境变量配置时，使用逗号分隔的 `key=value` 格式：

```sh
export OPENCODE_OTLP_HEADERS='Authorization=Bearer <collector-token>'
export OPENCODE_RESOURCE_ATTRIBUTES='service.name=my-opencode,deployment.environment.name=development'
export OPENCODE_SPAN_ATTRIBUTES='team.name=platform'
```

`otlpHeaders` 用于接收端鉴权。要采集模型请求／响应头，需同时开启 `captureContent` 和 `captureHttpHeaders`；安装示例默认不采集这些请求头。
