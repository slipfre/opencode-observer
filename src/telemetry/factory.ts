import { machine, platform } from "node:os";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { name, version } from "../../package.json";
import type { Observer } from "../contract/observer.js";
import { createObserver } from "./observer.js";
import { createTimingProcessor } from "./timing.js";

export type TelemetryOptions = {
  serviceVersion?: string;
  endpoint: string;
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

export function createTelemetry(config: TelemetryOptions): Observer {
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
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: config.endpoint,
            headers: config.otlpHeaders,
            timeoutMillis: config.otlpTimeoutMillis,
          }),
          { exportTimeoutMillis: config.batchExportTimeoutMillis },
        ),
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
