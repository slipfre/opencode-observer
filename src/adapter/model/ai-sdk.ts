import {
  registerTelemetryIntegration,
  type OnStartEvent,
  type OnStepStartEvent,
  type OnStepFinishEvent,
  type TelemetryIntegration,
} from "ai";
import type { ModelInput, ModelMessage } from "../../contract/messages.js";
import type { LlmRequest } from "./request.js";
import { parseModelInput, parseModelOutput } from "./messages.js";
import { createGuard } from "../shared/guard.js";

const correlationHeader = "x-opencode-observer-request";

export type ModelCapture = {
  active(): boolean;
  input(value: ModelInput): void;
  output(value: ModelMessage[] | undefined): void;
};

type ModelCaptureListener = {
  start(event: OnStartEvent | OnStepStartEvent): void;
  input(event: OnStepStartEvent): void;
  output(event: OnStepFinishEvent): void;
  guard: ReturnType<typeof createGuard>;
  log(error: unknown): unknown;
};

type ModelCaptureBroker = { listeners: Set<ModelCaptureListener> };

export function createModelMessageCapture(options: {
  bind(input: LlmRequest[0]): ModelCapture | undefined;
  log(error: unknown): unknown;
}) {
  const pending = new Map<string, ModelCapture>();
  const bindings = new WeakMap<object, ModelCapture>();

  function activeBinding(event: OnStartEvent | OnStepStartEvent | OnStepFinishEvent) {
    if (event.functionId !== "session.llm") {
      return;
    }

    const binding = event.metadata ? bindings.get(event.metadata) : undefined;

    return binding?.active() ? binding : undefined;
  }

  const listener: ModelCaptureListener = {
    guard: createGuard(options.log),
    log: options.log,
    start(event) {
      const id = event.headers?.[correlationHeader];
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
      const binding = activeBinding(event);

      if (binding) {
        binding.input(parseModelInput(event));
      }
    },
    output(event) {
      const binding = activeBinding(event);

      if (binding) {
        binding.output(parseModelOutput(event));
      }
    },
  };
  const broker = modelCaptureBroker();
  broker.listeners.add(listener);

  return {
    attachCorrelationHeader(input: LlmRequest[0], output: { headers: Record<string, string> }) {
      if (Object.keys(output.headers).some((key) => key.toLowerCase() === correlationHeader)) {
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

      output.headers[correlationHeader] = id;
    },
    close() {
      broker.listeners.delete(listener);
      pending.clear();
    },
  };
}

function modelCaptureBroker() {
  const root = globalThis as typeof globalThis & {
    __opencodeObserverModelCapture?: ModelCaptureBroker;
  };

  if (root.__opencodeObserverModelCapture) {
    return root.__opencodeObserverModelCapture;
  }

  const broker: ModelCaptureBroker = { listeners: new Set() };
  // The broker outlives individual instances; only active instances receive its diagnostics.
  const guard = createGuard((error) =>
    Promise.allSettled(Array.from(broker.listeners, async (listener) => listener.log(error))),
  );
  const integration: TelemetryIntegration = {
    onStart(event) {
      return guard(() => {
        broker.listeners.forEach((listener) => void listener.guard(() => listener.start(event)));
        // OpenCode copies hook headers. Strip our correlation token from the prepared
        // object before the provider runs, including requests from disposed instances.
        if (event.headers) {
          delete event.headers[correlationHeader];
        }
      });
    },
    onStepStart(event) {
      return guard(() => {
        broker.listeners.forEach(
          (listener) =>
            void listener.guard(() => {
              listener.start(event);
              listener.input(event);
            }),
        );

        if (event.headers) {
          delete event.headers[correlationHeader];
        }
      });
    },
    onStepFinish(event) {
      return guard(() => {
        broker.listeners.forEach((listener) => void listener.guard(() => listener.output(event)));
      });
    },
  };
  registerTelemetryIntegration(integration);
  root.__opencodeObserverModelCapture = broker;

  return broker;
}
