import { machine, platform } from "node:os";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { name, version } from "../../package.json";
import type { Observer } from "../contract/observer.js";
import { createObserver } from "./observer.js";

export type TelemetryOptions = {
  serviceVersion?: string;
  endpoint: string;
  captureContent: boolean;
  spanNamePrefix: string;
  otlpHeaders: Record<string, string>;
  resourceAttributes: Record<string, string>;
  spanAttributes: Record<string, string>;
  spanAttributeCountLimit: number;
};

export function createTelemetry(config: TelemetryOptions): Observer {
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
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: config.endpoint,
          headers: config.otlpHeaders,
          timeoutMillis: 5000,
        }),
        { exportTimeoutMillis: 5000 },
      ),
    ],
  });

  return createObserver({
    tracerProvider,
    instrumentationScope: { name, version },
    spanNamePrefix: config.spanNamePrefix,
    captureContent: config.captureContent,
    spanAttributes: config.spanAttributes,
  });
}
