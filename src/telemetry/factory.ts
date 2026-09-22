import { machine, platform } from "node:os";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { name, version } from "../../package.json";
import type { Observer } from "../contract/observer.js";
import { createObserver } from "./observer.js";
import { createTimingProcessor } from "./timing.js";

export type TelemetryOptions = {
  serviceVersion?: string;
  endpoint: string;
  otlpProtocol: "http/json" | "http/protobuf" | "grpc";
  captureContent: boolean;
  captureHttpHeaders?: boolean;
  spanNamePrefix: string;
  attributePrefix: string;
  otlpHeaders: Record<string, string>;
  otlpTimeoutMillis: number;
  batchExportTimeoutMillis: number;
  forceFlushTimeoutMillis: number;
  resourceAttributes: Record<string, string>;
  spanAttributes: Record<string, string>;
  spanAttributeCountLimit: number;
};

export async function createTelemetry(config: TelemetryOptions): Promise<Observer> {
  const exporter = await createExporter(config);
  const spanStartTimes = new WeakMap<object, number>();
  const hostArchByMachine: Record<string, string> = {
    x86_64: "amd64",
    AMD64: "amd64",
    aarch64: "arm64",
    arm64: "arm64",
    i386: "x86",
    i686: "x86",
    armv7l: "arm32",
  };
  const hostArch = hostArchByMachine[machine()];
  const osType =
    platform() === "win32" ? "windows" : platform() === "sunos" ? "solaris" : platform();

  const tracerProvider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "opencode",
      ...(config.serviceVersion ? { "service.version": config.serviceVersion } : {}),
      "os.type": osType,
      ...(hostArch ? { "host.arch": hostArch } : {}),
      ...config.resourceAttributes,
    }),
    spanLimits: { attributeCountLimit: config.spanAttributeCountLimit },
    forceFlushTimeoutMillis: config.forceFlushTimeoutMillis,
    spanProcessors: [
      createTimingProcessor(
        new BatchSpanProcessor(exporter, { exportTimeoutMillis: config.batchExportTimeoutMillis }),
        spanStartTimes,
      ),
    ],
  });

  return createObserver({
    tracerProvider,
    instrumentationScope: { name, version },
    spanNamePrefix: config.spanNamePrefix,
    attributePrefix: config.attributePrefix,
    captureContent: config.captureContent,
    captureHttpHeaders: config.captureHttpHeaders,
    spanAttributes: config.spanAttributes,
    spanStartTimes,
  });
}

async function createExporter(config: TelemetryOptions) {
  const options = { url: config.endpoint, timeoutMillis: config.otlpTimeoutMillis };
  if (config.otlpProtocol === "grpc") {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");
    const { Metadata } = await import("@grpc/grpc-js");
    const metadata = new Metadata();
    Object.entries(config.otlpHeaders).forEach(([key, value]) => metadata.set(key, value));
    return new OTLPTraceExporter({ ...options, metadata });
  }

  if (config.otlpProtocol === "http/protobuf") {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
    return new OTLPTraceExporter({ ...options, headers: config.otlpHeaders });
  }

  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  return new OTLPTraceExporter({ ...options, headers: config.otlpHeaders });
}
