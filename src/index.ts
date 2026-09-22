import type { Config, Plugin } from "@opencode-ai/plugin";
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

  const state = {
    setup: undefined as Promise<void> | undefined,
    coordinator: undefined as ReturnType<typeof createCoordinator> | undefined,
    disposed: false,
  };

  const initialize = async (providers: Config["provider"]) => {
    const userIDEnabled = isUserIDEnabled();
    const [serviceVersion, user] = await Promise.all([
      getOpenCodeVersion(input.client).catch(() => undefined),
      resolveUser(providers),
    ]);

    if (state.disposed) {
      return;
    }

    const observer = await createTelemetry({
      ...config,
      serviceVersion,
      spanAttributes: {
        ...(user === undefined ? {} : { "user.id": user?.id ?? "unknown" }),
        ...config.spanAttributes,
      },
    });
    if (state.disposed) {
      await observer.shutdown();
      return;
    }

    state.coordinator = createCoordinator({
      observer,
      captureContent: config.captureContent,
      captureHttpHeaders: config.captureHttpHeaders,
      llmTimingMode: config.llmTimingMode,
      userIdentity: { enabled: userIDEnabled, id: user?.id },
      log,
    });
    await state.coordinator.startSdkModelCapture().catch(log);
  };

  return {
    async config(hostConfig) {
      if (state.disposed) {
        return;
      }

      state.setup ??= initialize(hostConfig.provider);
      await state.setup;
    },
    async dispose() {
      state.disposed = true;
      const disposal = state.coordinator?.hooks.dispose();
      await state.setup;
      await disposal;
    },
    async "chat.message"(input, output) {
      await state.coordinator?.hooks["chat.message"](input, output);
    },
    async "chat.params"(input, output) {
      await state.coordinator?.hooks["chat.params"](input, output);
    },
    async "chat.headers"(input, output) {
      await state.coordinator?.hooks["chat.headers"](input, output);
    },
    async event(input) {
      await state.coordinator?.hooks.event(input);
    },
  };
};
