import type { Hooks } from "@opencode-ai/plugin";
import type { Observer } from "../contract/observer.js";
import { createCoordinator } from "./coordinator.js";
import type { captureModelMessages } from "./ai-sdk.js";

export function createOpencodeAdapter(options: {
  observer: Observer;
  directory: string;
  captureContent: boolean;
  onError: (error: unknown) => void;
  onDispose: () => Promise<void>;
}) {
  const coordinator = createCoordinator({
    observer: options.observer,
    captureContent: options.captureContent,
  });
  const state = {
    closed: false,
    messages: undefined as ReturnType<typeof captureModelMessages> | undefined,
    installing: undefined as Promise<void> | undefined,
  };
  const hooks: Hooks = {
    "chat.message": async (_input, output) => {
      if (state.closed) {
        return;
      }

      // Isolate synchronous observer failures without deferring source event processing.
      try {
        coordinator.userMessage(output.message, output.parts);
      } catch (error) {
        options.onError(error);
      }
    },
    "chat.params": async (input, output) => {
      if (state.closed) {
        return;
      }

      try {
        coordinator.request(input, output);
      } catch (error) {
        options.onError(error);
      }
    },
    "chat.headers": async (input, output) => {
      if (state.closed) {
        return;
      }

      try {
        state.messages?.headers(input, output);
      } catch (error) {
        options.onError(error);
      }
    },
    event: async ({ event }) => {
      const observedAt = Date.now();

      if (
        event.type === "server.instance.disposed" &&
        event.properties.directory === options.directory
      ) {
        return options.onDispose();
      }

      if (state.closed) {
        return;
      }

      try {
        coordinator.event(event, observedAt);

        if (
          event.type === "session.idle" ||
          event.type === "session.error" ||
          event.type === "session.deleted" ||
          (event.type === "session.status" && event.properties.status.type === "idle")
        ) {
          void options.observer.flush().catch(options.onError);
        }
      } catch (error) {
        options.onError(error);
      }
    },
  };

  async function installMessages() {
    const { captureModelMessages } = await import("./ai-sdk.js");

    if (!state.closed) {
      state.messages = captureModelMessages({
        bind: coordinator.bindModel,
        onError: options.onError,
      });
    }
  }

  return {
    hooks,
    captureMessages() {
      // Native runtime bypasses AI SDK callbacks, so it cannot consume a correlation header.
      const native = ["1", "true", "yes", "on"].includes(
        (process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM ?? "").toLowerCase(),
      );

      if (!options.captureContent || state.closed || native) {
        return Promise.resolve();
      }

      state.installing ??= installMessages();

      return state.installing;
    },
    close() {
      state.closed = true;
      state.messages?.close();
      coordinator.close();
    },
  };
}
