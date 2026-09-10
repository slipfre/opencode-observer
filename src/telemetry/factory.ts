import { machine, platform } from "node:os";
import { ROOT_CONTEXT, defaultTextMapGetter } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { version } from "../../package.json";
import type { Observer } from "../contract/observer.js";
import { createObserver } from "./observer.js";

export type TelemetryOptions = {
  endpoint: string;
  captureContent: boolean;
  tracePrefix: string;
  traceparent: string;
  tracestate: string;
  headers: Record<string, string>;
  resourceAttributes: Record<string, string>;
  spanAttributes: Record<string, string>;
  attributeCountLimit: number;
};

export function createTelemetry(config: TelemetryOptions): Observer {
  const architectures: Record<string, string> = {
    x86_64: "amd64",
    AMD64: "amd64",
    aarch64: "arm64",
    arm64: "arm64",
    i386: "x86",
    i686: "x86",
    armv7l: "arm32",
  };
  const hostArch = architectures[machine()];
  const osType =
    platform() === "win32" ? "windows" : platform() === "sunos" ? "solaris" : platform();

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "opencode",
      "os.type": osType,
      ...(hostArch ? { "host.arch": hostArch } : {}),
      ...config.resourceAttributes,
    }),
    spanLimits: { attributeCountLimit: config.attributeCountLimit },
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: config.endpoint,
          headers: config.headers,
          timeoutMillis: 5000,
        }),
        { exportTimeoutMillis: 5000 },
      ),
    ],
  });

  const rootContext = new W3CTraceContextPropagator().extract(
    ROOT_CONTEXT,
    {
      traceparent: config.traceparent,
      tracestate: config.tracestate,
    },
    defaultTextMapGetter,
  );

  return createObserver({
    provider,
    rootContext,
    scope: { name: "opencode-observer", version },
    tracePrefix: config.tracePrefix,
    captureContent: config.captureContent,
    attributes: config.spanAttributes,
  });
}
