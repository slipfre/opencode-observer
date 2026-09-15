import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";

export const ObserverPlugin: Plugin = async (input, options) => {
  const config = loadConfig(options);

  if (!config.enabled) {
    return {};
  }

  const { createTelemetry } = await import("./telemetry/factory.js");
  const { createCoordinator } = await import("./adapter/opencode/coordinator.js");
  const { getOpenCodeVersion } = await import("./adapter/opencode/version.js");
  const { resolveUser, isUserIDEnabled } = await import("./user/resolve.js");

  const userIDEnabled = isUserIDEnabled();
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

  const adapter = createCoordinator({
    observer,
    captureContent: config.captureContent,
    userIdentity: { enabled: userIDEnabled, id: user?.id },
    log,
  });
  await adapter.startModelMessageCapture().catch(log);
  return adapter.hooks;
};
