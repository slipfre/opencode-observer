import { parse } from "protobufjs";
import type { OtlpExport } from "./otlp-receiver.js";

// Decode the fields asserted by the receiver using their official OTLP field numbers.
// https://github.com/open-telemetry/opentelemetry-proto/tree/main/opentelemetry/proto
const request = parse(`
  syntax = "proto3";
  message AnyValue {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
  }
  message ArrayValue { repeated AnyValue values = 1; }
  message KeyValue { string key = 1; AnyValue value = 2; }
  message Resource { repeated KeyValue attributes = 1; }
  message InstrumentationScope { string name = 1; string version = 2; }
  message Status { string message = 2; int32 code = 3; }
  message Span {
    bytes trace_id = 1;
    bytes span_id = 2;
    string trace_state = 3;
    bytes parent_span_id = 4;
    string name = 5;
    int32 kind = 6;
    fixed64 start_time_unix_nano = 7;
    fixed64 end_time_unix_nano = 8;
    repeated KeyValue attributes = 9;
    Status status = 15;
  }
  message ScopeSpans {
    InstrumentationScope scope = 1;
    repeated Span spans = 2;
  }
  message ResourceSpans {
    Resource resource = 1;
    repeated ScopeSpans scope_spans = 2;
  }
  message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
`).root.lookupType("ExportTraceServiceRequest");

export function decodeProtobuf(body: Uint8Array): OtlpExport {
  const payload = request.toObject(request.decode(body), {
    longs: String,
    bytes: String,
    arrays: true,
  }) as OtlpExport;
  payload.resourceSpans.forEach((resource) =>
    resource.scopeSpans.forEach((group) =>
      group.spans.forEach((span) => {
        span.traceId = Buffer.from(span.traceId, "base64").toString("hex");
        span.spanId = Buffer.from(span.spanId, "base64").toString("hex");
        if (span.parentSpanId) {
          span.parentSpanId = Buffer.from(span.parentSpanId, "base64").toString("hex");
        }
      }),
    ),
  );
  return payload;
}
