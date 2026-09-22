# opencode-observer

OpenCode 可观测性插件，记录任务执行、用户交互、模型调用、工具执行、技能加载、上下文压缩和权限检查，通过 OTLP HTTP/JSON 导出到遥测接收端，便于查看执行过程、耗时、token 用量和错误。

支持按需采集输入输出正文、工具定义及模型 HTTP 请求／响应头。遥测和正文采集默认关闭。

## 安装与使用

准备支持 OTLP HTTP/JSON 的遥测接收端，然后在 OpenCode 的 `opencode.json` 中添加插件：

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

将 `endpoint` 替换为实际接收端地址。启动 OpenCode 并执行任务后，即可在接收端查看 trace；默认服务名称为 `opencode`。

上述示例同时开启遥测和正文采集。只需耗时、token 用量和错误等信息时，可移除 `captureContent` 或将其设为 `false`。

## 配置

支持插件选项和环境变量，插件选项优先于对应环境变量。布尔环境变量接受 `true` / `false` / `1` / `0`。

| 插件选项                   | 环境变量                              | 默认值                  | 说明                                                                           |
| -------------------------- | ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `enabled`                  | `OPENCODE_ENABLE_TELEMETRY`           | `false`                 | 开启遥测                                                                       |
| `captureContent`           | `OPENCODE_CAPTURE_CONTENT`            | `false`                 | 采集输入输出正文、LLM 工具定义和工具执行描述                                   |
| `captureHttpHeaders`       | `OPENCODE_CAPTURE_HTTP_HEADERS`       | `false`                 | 采集模型请求／响应头，需同时开启 `captureContent`                              |
| `llmTimingMode`            | `OPENCODE_LLM_TIMING_MODE`            | `message`               | `message` 按模型消息创建到完成计时；`fetch` 按模型请求开始到响应体读取结束计时 |
| `endpoint`                 | `OPENCODE_OTLP_ENDPOINT`              | `http://localhost:4318` | HTTP(S) 接收端地址，自动补齐 `/v1/traces`                                      |
| `tracePrefix`              | `OPENCODE_TRACE_PREFIX`               | `opencode.`             | span 名称前缀                                                                  |
| `attributePrefix`          | `OPENCODE_ATTRIBUTE_PREFIX`           | `opencode.`             | 插件生成的内建 `opencode.*` span 属性键前缀                                    |
| `otlpHeaders`              | `OPENCODE_OTLP_HEADERS`               | 空                      | 发往遥测接收端的请求头，例如鉴权信息                                           |
| `otlpTimeoutMillis`        | `OPENCODE_OTLP_TIMEOUT`               | `10000`                 | 单批 OTLP 发送与重试的时间预算，单位毫秒                                       |
| `batchExportTimeoutMillis` | `OPENCODE_BATCH_EXPORT_TIMEOUT`       | `30000`                 | 批处理器等待单批导出完成的上限，单位毫秒                                       |
| `forceFlushTimeoutMillis`  | `OPENCODE_FORCE_FLUSH_TIMEOUT`        | `30000`                 | 主动刷新等待完成的上限，单位毫秒                                               |
| `resourceAttributes`       | `OPENCODE_RESOURCE_ATTRIBUTES`        | 空                      | 自定义 resource 属性，可覆盖默认服务名称等属性                                 |
| `spanAttributes`           | `OPENCODE_SPAN_ATTRIBUTES`            | 空                      | 自定义 span 属性；受保护的内建字段不可覆盖                                     |
| `spanAttributeCountLimit`  | `OPENCODE_SPAN_ATTRIBUTE_COUNT_LIMIT` | `4096`                  | 每个 span 的属性数量上限，必须为正整数                                         |

`llmTimingMode` 同时决定首块耗时的计时起点。`fetch` 模式包含中间重试等待，无法取得完整计时数据时回退到 `message`。这些耗时可能包含本地处理或重试等待，不代表服务端纯推理时间；首块耗时也不是网络首字节耗时。

`attributePrefix` 与 `tracePrefix` 独立配置，未配置时各自使用 `opencode.`，不会互相继承。例如 `tracePrefix: "agent."`、`attributePrefix: "app."` 会生成 `agent.llm` span，并将内建 `opencode.message.id` 写为 `app.message.id`。两项均按字符串原样拼接，不自动补 `.`；空字符串表示移除对应前缀。

属性前缀只作用于插件生成的内建 `opencode.*` span 属性键，标准字段及 `ai.agent.skill.name` 保持原名。显式配置的 `spanAttributes`、`resourceAttributes` 和属性值不做重命名；`spanAttributes` 仍不能注入默认前缀或配置前缀下受保护的内建字段，也不能绕过正文采集开关。其他自定义键（例如 `opencode.custom.tag`）原样保留。内建字段只导出配置后的键名，不额外保留默认键名。

### 导出超时与重试

三个超时均接受 `1` 到 `2147483647` 的整数，单位为毫秒；插件选项优先于对应的 `OPENCODE_*` 环境变量，未配置时使用表中的默认值。这些值由插件配置控制，不读取 SDK 的 `OTEL_EXPORTER_OTLP_TIMEOUT`、`OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` 或 `OTEL_BSP_EXPORT_TIMEOUT`。

建议 `batchExportTimeoutMillis` 大于 `otlpTimeoutMillis`，为导出收尾留出余量；`forceFlushTimeoutMillis` 不小于 `batchExportTimeoutMillis`。三者分别限制不同层的等待，不会累加；`forceFlushTimeoutMillis` 只限制主动刷新，不是插件关闭的总超时。增大导出超时可能延长退出时的等待。

SDK 对可重试的网络错误和 HTTP 响应进行有限的退避重试，重试同时受到时间预算和次数上限限制。超时不是每次重试独享的时长，增大它也不保证用满预算。最终发送失败的批次不会重新入队；缓存仅保留在内存中，不支持离线持久化或恢复后的可靠补报。

### 使用环境变量

在 `opencode.json` 中只声明插件：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-observer"]
}
```

在启动 OpenCode 的终端中设置环境变量：

```sh
export OPENCODE_ENABLE_TELEMETRY=true
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
