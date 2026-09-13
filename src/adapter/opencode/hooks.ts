import type { Hooks } from "@opencode-ai/plugin";
import type { Observer } from "../../contract/observer.js";
import { createCoordinator } from "./coordinator.js";
import type { createModelMessageCapture } from "../model/ai-sdk.js";
import { createGuard } from "../shared/guard.js";

export function createOpenCodeAdapter(options: {
  observer: Observer;
  directory: string;
  captureContent: boolean;
  log: (error: unknown) => unknown;
  onDispose: () => Promise<void>;
}) {
  const guard = createGuard(options.log);
  const coordinator = createCoordinator({
    observer: options.observer,
    captureContent: options.captureContent,
  });
  const state = {
    closed: false,
    messageCapture: undefined as ReturnType<typeof createModelMessageCapture> | undefined,
    messageCaptureSetup: undefined as Promise<void> | undefined,
  };
  const hooks: Hooks = {
    dispose: () => guard(options.onDispose),
    "chat.message": (_input, output) =>
      guard(() => {
        if (state.closed) {
          return;
        }

        coordinator.userMessage(output.message, output.parts);
      }),
    "chat.params": (input, output) =>
      guard(() => {
        if (state.closed) {
          return;
        }

        coordinator.request(input, output);
      }),
    "chat.headers": (input, output) =>
      guard(() => {
        if (state.closed) {
          return;
        }

        state.messageCapture?.attachCorrelationHeader(input, output);
      }),
    event: (input) =>
      guard(() => {
        const observedAt = Date.now();
        const event = input.event;

        if (
          event.type === "server.instance.disposed" &&
          event.properties.directory === options.directory
        ) {
          return options.onDispose();
        }

        if (state.closed) {
          return;
        }

        coordinator.event(event, observedAt);

        if (
          event.type === "session.idle" ||
          event.type === "session.error" ||
          event.type === "session.deleted" ||
          (event.type === "session.status" && event.properties.status.type === "idle")
        ) {
          void guard(() => options.observer.flush());
        }
      }),
  };

  async function installModelMessageCapture() {
    const { createModelMessageCapture } = await import("../model/ai-sdk.js");

    if (!state.closed) {
      state.messageCapture = createModelMessageCapture({
        bind: coordinator.bindModel,
        log: options.log,
      });
    }
  }

  return {
    hooks,
    startModelMessageCapture() {
      // Native runtime bypasses AI SDK callbacks, so it cannot consume a correlation header.
      const native = ["1", "true", "yes", "on"].includes(
        (process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM ?? "").toLowerCase(),
      );

      if (!options.captureContent || state.closed || native) {
        return Promise.resolve();
      }

      state.messageCaptureSetup ??= installModelMessageCapture();

      return state.messageCaptureSetup;
    },
    close() {
      state.closed = true;
      void guard(() => state.messageCapture?.close());
      void guard(() => coordinator.close());
    },
  };
}
