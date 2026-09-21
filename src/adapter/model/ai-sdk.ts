import {
  registerTelemetryIntegration,
  type OnStartEvent,
  type OnStepStartEvent,
  type OnStepFinishEvent,
  type OnToolCallStartEvent,
  type TelemetryIntegration,
} from "ai";
import type { LlmUpdate } from "../../contract/observer.js";
import type { ChatParamsHookArgs } from "./request.js";
import { parseModelInput, parseModelOutput } from "./messages.js";
import { createGuard, reportError } from "../shared/guard.js";
import { parseModelHeaders } from "./headers.js";
import { parseModelSettings } from "./settings.js";

const correlationHeader = "x-opencode-observer-request";

export type ModelCapture = {
  active(): boolean;
  input(value: Pick<LlmUpdate, "input" | "request">): void;
  output(value: Pick<LlmUpdate, "output" | "responseModel" | "responseHeaders">): void;
  toolDescription(value: { callID: string; name: string; description: string }): void;
};

type ModelCaptureListener = {
  start(event: OnStartEvent | OnStepStartEvent): void;
  input(event: OnStepStartEvent): void;
  output(event: OnStepFinishEvent): void;
  tool(event: OnToolCallStartEvent): void;
  guard: ReturnType<typeof createGuard>;
  log(error: unknown): unknown;
};

type ModelCaptureBroker = { listeners: Set<ModelCaptureListener> };

export function createSdkModelCapture(options: {
  bind(input: ChatParamsHookArgs[0]): ModelCapture | undefined;
  captureContent: boolean;
  captureHttpHeaders: boolean;
  log(error: unknown): unknown;
}) {
  const pendingCaptures = new Map<string, ModelCapture>();
  const bindings = new WeakMap<
    object,
    {
      capture: ModelCapture;
      step: number;
      stepFinished: boolean;
      stepNumber?: number;
      toolDescriptions?: Map<string, string>;
    }
  >();

  function activeBinding(
    event: OnStartEvent | OnStepStartEvent | OnStepFinishEvent | OnToolCallStartEvent,
  ) {
    if (event.functionId !== "session.llm") {
      return;
    }

    const binding = event.metadata ? bindings.get(event.metadata) : undefined;
    return binding?.capture.active() ? binding : undefined;
  }

  const listener: ModelCaptureListener = {
    guard: createGuard(options.log),
    log: options.log,
    start(event) {
      const id = event.headers?.[correlationHeader];
      const binding = id ? pendingCaptures.get(id) : undefined;

      if (!id || !binding) {
        return;
      }

      pendingCaptures.delete(id);

      if (event.functionId === "session.llm" && event.metadata && binding.active()) {
        bindings.set(event.metadata, { capture: binding, step: 0, stepFinished: false });
      }
    },
    input(event) {
      const binding = activeBinding(event);

      if (binding) {
        const step = ++binding.step;
        const snapshot = {
          ...(options.captureContent ? { input: parseModelInput(event) } : {}),
          request: {
            // SDK text generation is known before any asynchronous tool schemas resolve.
            outputType: event.output === undefined ? ("text" as const) : undefined,
            ...(options.captureContent && options.captureHttpHeaders
              ? { headers: parseModelHeaders(event.headers) }
              : {}),
          },
        };
        binding.capture.input(snapshot);
        binding.stepFinished = false;
        binding.stepNumber = event.stepNumber;
        binding.toolDescriptions = undefined;

        if (options.captureContent) {
          // Tool descriptions are available before asynchronous parameter schemas resolve.
          void listener.guard(() => {
            binding.toolDescriptions = new Map(
              Object.entries(event.tools ?? {})
                .filter(
                  ([name]) => event.activeTools === undefined || event.activeTools.includes(name),
                )
                .flatMap(([name, tool]) =>
                  typeof tool.description === "string" ? [[name, tool.description] as const] : [],
                ),
            );
          });
        }

        if (event.output || (options.captureContent && event.tools)) {
          // Schema promises must never hold up the host or hide an observed response.
          // Only enrich the request while this step is still awaiting its response.
          void listener.guard(async () => {
            const settings = await parseModelSettings(event, options.captureContent, (error) =>
              reportError(error, options.log),
            );

            if (
              broker.listeners.has(listener) &&
              binding.capture.active() &&
              binding.step === step &&
              !binding.stepFinished
            ) {
              binding.capture.input({ ...snapshot, request: { ...snapshot.request, ...settings } });
            }
          });
        }
      }
    },
    output(event) {
      const binding = activeBinding(event);

      if (binding) {
        binding.stepFinished = true;
        binding.toolDescriptions = undefined;
        const snapshot = {
          responseModel: event.response?.modelId,
          ...(options.captureContent ? { output: parseModelOutput(event) } : {}),
          ...(options.captureContent && options.captureHttpHeaders
            ? { responseHeaders: parseModelHeaders(event.response?.headers) }
            : {}),
        };
        binding.capture.output(snapshot);
      }
    },
    tool(event) {
      const binding = activeBinding(event);
      if (!binding || binding.stepFinished || binding.stepNumber !== event.stepNumber) {
        return;
      }

      const description = binding.toolDescriptions?.get(event.toolCall.toolName);
      if (description !== undefined) {
        binding.capture.toolDescription({
          callID: event.toolCall.toolCallId,
          name: event.toolCall.toolName,
          description,
        });
      }
    },
  };
  const broker = getModelCaptureBroker();
  broker.listeners.add(listener);

  return {
    attachCorrelationHeader(
      input: ChatParamsHookArgs[0],
      output: { headers: Record<string, string> },
    ) {
      if (Object.keys(output.headers).some((key) => key.toLowerCase() === correlationHeader)) {
        return;
      }

      const binding = options.bind(input);

      if (!binding) {
        return;
      }

      pendingCaptures.forEach((value, key) => {
        if (!value.active()) {
          pendingCaptures.delete(key);
        }
      });
      const id = crypto.randomUUID();
      pendingCaptures.set(id, binding);

      if (pendingCaptures.size > 1024) {
        const oldest = pendingCaptures.keys().next().value;

        if (oldest) {
          pendingCaptures.delete(oldest);
        }
      }

      output.headers[correlationHeader] = id;
    },
    close() {
      broker.listeners.delete(listener);
    },
  };
}

function getModelCaptureBroker() {
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
      broker.listeners.forEach((listener) => void listener.guard(() => listener.output(event)));
    },
    onToolCallStart(event) {
      broker.listeners.forEach((listener) => void listener.guard(() => listener.tool(event)));
    },
  };
  registerTelemetryIntegration(integration);
  root.__opencodeObserverModelCapture = broker;

  return broker;
}
