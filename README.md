# opencode-observer

OpenCode 可观测性插件，记录任务执行、用户交互、模型调用、工具执行、技能加载、上下文压缩和权限检查，通过 OTLP 导出到遥测接收端，默认使用 HTTP/JSON，也支持 HTTP/Protobuf 和 gRPC，便于查看执行过程、耗时、token 用量和错误。

支持按需采集输入输出正文、工具定义及模型 HTTP 请求／响应头。遥测和正文采集默认关闭。

## 安装与使用

推荐从本项目的 GitHub Release 下载单文件 JS 安装，支持 OTLP HTTP/JSON、HTTP/Protobuf 和 gRPC。准备遥测接收端后，选择与接收端匹配的导出协议和地址，具体见 [OTLP 协议](#otlp-协议)。

本项目目前未发布到 npm registry。npm 上的同名包 `opencode-observer` 属于其他项目，请勿按该包名安装或在 `opencode.json` 中按该包名加载；指定版本号也不会加载本项目。

### 下载并加载单文件 JS

从 [GitHub Releases](https://github.com/slipfre/opencode-observer/releases) 选择版本并下载附件 `opencode-observer.js`，也可直接下载[最新正式版 JS](https://github.com/slipfre/opencode-observer/releases/latest/download/opencode-observer.js)。该文件包含插件运行所需的第三方依赖，由 OpenCode 的 Bun 运行时加载，无需为插件单独安装 npm 依赖。

下载后可选择自动加载并使用环境变量，或在 `opencode.json` 中显式加载并配置插件选项。

#### 自动加载，使用环境变量

将下载的 `opencode-observer.js` 复制到以下任意一个位置：

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

启动 OpenCode 并执行任务后，即可在接收端查看 trace；默认服务名称为 `opencode`。正文采集默认关闭，需要时设置 `OPENCODE_CAPTURE_CONTENT=true`。其他配置同样使用下表中的环境变量。

项目级和用户级插件目录只选择一个安装，以免重复采集。

#### 在 opencode.json 中加载并配置

将下载的 JS 文件保存为 `<项目目录>/.opencode/vendor/opencode-observer.js`，然后在项目根目录的 `opencode.json` 中添加以下 `plugin` 条目；已有其他插件时，保留原有条目：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "./.opencode/vendor/opencode-observer.js",
      {
        "enabled": true,
        "otlpProtocol": "http/json",
        "endpoint": "http://localhost:4318",
        "captureContent": false
      }
    ]
  ]
}
```

相对路径以声明该插件的 `opencode.json` 所在目录为基准。用户级配置也可使用相对路径，例如将 JS 放在 `~/.config/opencode/vendor/opencode-observer.js`，在 `~/.config/opencode/opencode.json` 中使用 `./vendor/opencode-observer.js`；设置了 `XDG_CONFIG_HOME` 时，配置目录为其下的 `opencode/`。

也可使用绝对文件 URL，例如 Linux/macOS 的 `file:///opt/opencode-observer/opencode-observer.js` 或 Windows 的 `file:///D:/Tools/opencode-observer/opencode-observer.js`，请替换为实际文件位置。

`plugin` 条目采用 `[本地文件路径, 插件选项]` 的形式，选项名称见下表。上述示例开启遥测，正文采集保持关闭，需要时将 `captureContent` 设为 `true`。保存配置后启动 OpenCode 即可使用，无需另设同名环境变量；插件选项优先于对应环境变量。

显式加载时，将 JS 放在示例中的 `vendor/` 等非自动加载目录，移除项目级和用户级 `plugins/`（或 `plugin/`）目录中本插件的副本，以免自动发现与显式配置同时加载或覆盖插件选项。

两种方式升级时均替换同一路径下的 JS 文件并重启 OpenCode；回退时换回旧版本文件。

### 从源码构建

也可在本仓库根目录运行：

```sh
bun install --frozen-lockfile
bun run build:standalone
```

将生成的 `dist/standalone/opencode-observer.js` 按上述任一方式安装：复制到自动加载目录，或保存到其他目录并在 `opencode.json` 中显式加载。`dist/index.js` 是依赖外部包的构建入口，不能替代独立构建文件。

### 从旧安装说明迁移

如果曾按旧说明配置 npm 包加载，请先移除项目级和用户级 OpenCode 配置中指向 `opencode-observer` 的 `plugin` 条目，包括带版本号或选项的条目。如果还曾手动安装同名 npm 包，请在原安装位置用对应包管理器移除该依赖。

然后按上述任一方式安装本项目的单文件 JS，并重启 OpenCode。选择自动加载时，将原插件选项按下表转换为环境变量，无需在 `opencode.json` 中声明插件；选择显式加载时，将原条目中的 npm 包名替换为下载文件的本地路径，保留原插件选项。

## 配置

单文件自动加载时，使用环境变量配置；在 `opencode.json` 中显式加载时，可直接传入插件选项。插件选项优先于对应环境变量。布尔环境变量接受 `true` / `false` / `1` / `0`。

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

安装单文件 JS 后，在启动 OpenCode 的终端中设置环境变量，协议和地址需与接收端匹配。以下以 HTTP/JSON 为例，同时开启遥测和正文采集；只需耗时、token 用量和错误等信息时，省略 `OPENCODE_CAPTURE_CONTENT` 或将其设为 `false`：

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
