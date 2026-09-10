import {
  registerTelemetryIntegration,
  type OnStartEvent,
  type OnStepStartEvent,
  type OnStepFinishEvent,
  type TelemetryIntegration,
} from "ai";
import type { ModelInput, ModelMessage } from "../contract/messages.js";
import type { LlmRequest } from "./llm.js";
import { modelInput, modelOutput } from "./messages.js";

const requestHeader = "x-opencode-observer-request";

export type ModelCapture = {
  active(): boolean;
  input(value: ModelInput): void;
  output(value: ModelMessage[] | undefined): void;
};

type Listener = {
  start(event: OnStartEvent | OnStepStartEvent): void;
  input(event: OnStepStartEvent): void;
  output(event: OnStepFinishEvent): void;
  error(error: unknown): void;
};

type Broker = { listeners: Set<Listener> };

export function captureModelMessages(options: {
  bind(input: LlmRequest[0]): ModelCapture | undefined;
  onError(error: unknown): void;
}) {
  const pending = new Map<string, ModelCapture>();
  const bindings = new WeakMap<object, ModelCapture>();

  function target(event: OnStartEvent | OnStepStartEvent | OnStepFinishEvent) {
    if (event.functionId !== "session.llm") {
      return;
    }

    const binding = event.metadata ? bindings.get(event.metadata) : undefined;

    return binding?.active() ? binding : undefined;
  }

  const listener: Listener = {
    error: options.onError,
    start(event) {
      const id = event.headers?.[requestHeader];
      const binding = id ? pending.get(id) : undefined;

      if (!id || !binding) {
        return;
      }

      pending.delete(id);

      if (event.functionId === "session.llm" && event.metadata && binding.active()) {
        bindings.set(event.metadata, binding);
      }
    },
    input(event) {
      const binding = target(event);

      if (binding) {
        binding.input(modelInput(event));
      }
    },
    output(event) {
      const binding = target(event);

      if (binding) {
        binding.output(modelOutput(event));
      }
    },
  };
  const broker = modelBroker();
  broker.listeners.add(listener);

  return {
    headers(input: LlmRequest[0], output: { headers: Record<string, string> }) {
      if (Object.keys(output.headers).some((key) => key.toLowerCase() === requestHeader)) {
        return;
      }

      const binding = options.bind(input);

      if (!binding) {
        return;
      }

      pending.forEach((value, key) => {
        if (!value.active()) {
          pending.delete(key);
        }
      });
      const id = crypto.randomUUID();
      pending.set(id, binding);

      if (pending.size > 1024) {
        const oldest = pending.keys().next().value;

        if (oldest) {
          pending.delete(oldest);
        }
      }

      output.headers[requestHeader] = id;
    },
    close() {
      broker.listeners.delete(listener);
      pending.clear();
    },
  };
}

function modelBroker() {
  const root = globalThis as typeof globalThis & { __opencodeObserverMessages?: Broker };

  if (root.__opencodeObserverMessages) {
    return root.__opencodeObserverMessages;
  }

  const broker: Broker = { listeners: new Set() };
  const integration: TelemetryIntegration = {
    onStart(event) {
      broker.listeners.forEach((listener) => dispatch(listener, () => listener.start(event)));
      // OpenCode copies hook headers. Strip our correlation token from the prepared
      // object before the provider runs, including requests from disposed instances.
      if (event.headers) {
        delete event.headers[requestHeader];
      }
    },
    onStepStart(event) {
      broker.listeners.forEach((listener) =>
        dispatch(listener, () => {
          listener.start(event);
          listener.input(event);
        }),
      );

      if (event.headers) {
        delete event.headers[requestHeader];
      }
    },
    onStepFinish(event) {
      broker.listeners.forEach((listener) => dispatch(listener, () => listener.output(event)));
    },
  };
  registerTelemetryIntegration(integration);
  root.__opencodeObserverMessages = broker;

  return broker;
}

function dispatch(listener: Listener, callback: () => void) {
  try {
    callback();
  } catch (error) {
    try {
      listener.error(error);
    } catch {
      // Diagnostics must not interrupt another instance or prevent header cleanup.
    }
  }
}
