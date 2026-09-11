import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";

export const ObserverPlugin: Plugin = async (input, options) => {
  const config = loadConfig(options);

  if (!config.enabled) {
    return {};
  }

  const { createTelemetry } = await import("./telemetry/factory.js");
  const { createOpenCodeAdapter } = await import("./adapter/opencode.js");
  const { getOpenCodeVersion } = await import("./adapter/version.js");
  const { resolveUser } = await import("./user/resolve.js");

  const [serviceVersion, user] = await Promise.all([
    getOpenCodeVersion(input.client).catch(() => undefined),
    resolveUser(),
  ]);
  const observer = createTelemetry({
    ...config,
    serviceVersion,
    spanAttributes: {
      ...(user === null ? { "user.id": "unknown" } : {}),
      ...config.spanAttributes,
      ...(user ? { "user.id": user.id } : {}),
    },
  });

  const log = async (error: unknown) => {
    await input.client.app
      .log({
        signal: AbortSignal.timeout(1000),
        body: {
          service: "opencode-observer",
          level: "error",
          message: error instanceof Error ? error.message : "Trace processing failed",
        },
      })
      .catch(() => undefined);
  };

  const adapter = createOpenCodeAdapter({
    observer,
    directory: input.directory,
    captureContent: config.captureContent,
    onError(error) {
      void log(error);
    },
    onDispose: shutdown,
  });
  await adapter.startModelMessageCapture().catch(log);

  function shutdown() {
    process.off("beforeExit", beforeExit);
    adapter.close();

    return observer.shutdown().catch(log);
  }

  function beforeExit() {
    void shutdown();
  }

  process.once("beforeExit", beforeExit);

  return adapter.hooks;
};
