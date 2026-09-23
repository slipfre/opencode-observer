import type { Config, Plugin } from "@opencode-ai/plugin";
import { version } from "../package.json";
import { loadConfig } from "./config.js";

export const ObserverPlugin: Plugin = async (input, options) => {
  const config = loadConfig(options);

  if (!config.enabled) {
    return {};
  }

  const { createTelemetry } = await import("./telemetry/factory.js");
  const { probeEndpoint } = await import("./telemetry/probe.js");
  const { createCoordinator } = await import("./adapter/opencode/coordinator.js");
  const { getOpenCodeVersion } = await import("./adapter/opencode/version.js");
  const { resolveUser, isUserIDEnabled } = await import("./user/resolve.js");

  const log = (
    level: "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ) => {
    // Isolate synchronous throws and async failures without delaying host callbacks.
    void Promise.resolve()
      .then(() =>
        input.client.app.log({
          signal: AbortSignal.timeout(1000),
          body: { service: "opencode-observer", level, message, extra },
        }),
      )
      .catch(() => undefined);
  };
  const logError = (error: unknown) =>
    log("error", error instanceof Error ? error.message : "Trace processing failed");

  const state = {
    setup: undefined as Promise<void> | undefined,
    coordinator: undefined as ReturnType<typeof createCoordinator> | undefined,
    disposed: false,
    probe: new AbortController(),
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
      log: logError,
    });
    await state.coordinator.startSdkModelCapture().catch(logError);
    if (state.disposed) {
      return;
    }

    const url = new URL(config.endpoint);
    const endpoint = `${url.origin}${url.pathname}`;
    log("info", "Observer plugin initialized", {
      version,
      serviceVersion,
      endpoint,
      protocol: config.otlpProtocol,
    });
    void probeEndpoint(config.endpoint, state.probe.signal)
      .then((result) => {
        if (state.disposed) {
          return;
        }

        log(
          result.ok ? "info" : "warn",
          result.ok
            ? "OTLP endpoint TCP reachable"
            : "OTLP endpoint TCP unreachable; exports may fail",
          { endpoint, protocol: config.otlpProtocol, ms: result.ms, error: result.error },
        );
      })
      .catch(logError);
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
      state.probe.abort();
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
