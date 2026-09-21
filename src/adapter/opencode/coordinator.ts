import type { Hooks } from "@opencode-ai/plugin";
import type { Event, Part, UserMessage } from "@opencode-ai/sdk";
import type { PermissionRequest } from "@opencode-ai/sdk/v2";
import type {
  Observer,
  ObservationError,
  RunReference,
  ToolReference,
} from "../../contract/observer.js";
import { normalizeError } from "../shared/error.js";
import { nonNegativeNumber } from "../shared/number.js";
import { createGuard } from "../shared/guard.js";
import type { createSdkModelCapture } from "../model/ai-sdk.js";
import { createFetchModelCapture } from "../model/fetch.js";
import { parseErrorResponseHeaders } from "../model/headers.js";
import { withUserTraceState } from "../model/trace-state.js";
import { createInteractionTracker, type InteractionContext } from "../trackers/interaction.js";
import { createLlmTracker } from "../trackers/llm.js";
import { createRunTracker } from "../trackers/run.js";
import { createToolTracker } from "../trackers/tool.js";
import { createCompactionTracker } from "../trackers/compaction.js";
import { createPermissionTracker } from "../trackers/permission.js";
import { createSessionRegistry } from "./session.js";

export type OpenCodeEvent =
  | Event
  | { type: "message.part.updated"; properties: { part: Part; time?: number } }
  | { type: "permission.asked"; properties: PermissionRequest }
  | {
      type: "permission.replied";
      properties: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" };
    }
  | {
      type: "session.error";
      properties: { sessionID?: string; error?: unknown };
    };

export type CoordinatorOptions = {
  observer: Observer;
  captureContent?: boolean;
  captureHttpHeaders?: boolean;
  llmTimingMode?: "message" | "fetch";
  userIdentity?: { enabled: boolean; id?: string };
  now?: () => number;
  log?: (error: unknown) => unknown;
};

type ActiveRunState = {
  reference: RunReference;
  parentTool?: ToolReference;
  pendingOverflowError?: ObservationError;
  overflowTrigger?: { messageID: string; interactionContext?: InteractionContext };
};

export function createCoordinator(options: CoordinatorOptions) {
  const log = options.log ?? (() => {});
  const guard = createGuard(log);
  const userIdentity = options.userIdentity ? { ...options.userIdentity } : undefined;
  const runs = createRunTracker({
    observer: options.observer,
    captureContent: options.captureContent,
  });
  const activeRunsBySessionID = new Map<string, ActiveRunState>();
  const sessionRegistry = createSessionRegistry();
  const interactions = createInteractionTracker({
    observer: options.observer,
    captureContent: options.captureContent,
  });
  const compactions = createCompactionTracker({
    observer: options.observer,
    onFinish: (run, id, time, error) => llms.finishForCompaction(run, id, time, error),
  });
  const llms = createLlmTracker({
    observer: options.observer,
    captureContent: options.captureContent,
    captureHttpHeaders: options.captureHttpHeaders,
    llmTimingMode: options.llmTimingMode,
    onToolDescription: (run, messageID, value) => tools.describe(run, messageID, value),
  });
  const fetchCapture =
    options.llmTimingMode === "fetch"
      ? createFetchModelCapture({ log, now: options.now })
      : undefined;
  const tools = createToolTracker({
    observer: options.observer,
    captureContent: options.captureContent,
    onChildSessionObserved: sessionRegistry.bindParentTool,
    onStart(tool) {
      if (permissions.associate(tool)) {
        tools.markPermissionRejected(tool);
      }
    },
    onFinish(tool, time, error) {
      permissions.finishPendingForTool(tool, time, error);
      activeRunsBySessionID.forEach((child) => {
        if (
          child.parentTool?.callID === tool.callID &&
          child.parentTool.messageID === tool.messageID &&
          child.parentTool.interaction.id === tool.interaction.id &&
          child.parentTool.interaction.run.id === tool.interaction.run.id &&
          child.parentTool.interaction.run.sessionID === tool.interaction.run.sessionID
        ) {
          finishActiveRun(
            child.reference.sessionID,
            time,
            error ?? { type: "_OTHER", message: "task tool ended before subagent completed" },
          );
        }
      });
      sessionRegistry.unbindTool(tool);
    },
  });
  const permissions = createPermissionTracker({ observer: options.observer });
  const state = {
    shutdown: undefined as Promise<void> | undefined,
    sdkModelCapture: undefined as ReturnType<typeof createSdkModelCapture> | undefined,
    sdkModelCaptureSetup: undefined as Promise<void> | undefined,
  };
  const now = options.now ?? Date.now;
  const hooks = {
    dispose() {
      state.shutdown ??= guard(() => {
        void guard(() => state.sdkModelCapture?.close());
        void guard(() => fetchCapture?.close());
        const time = now();
        activeRunsBySessionID.forEach(
          (runState) =>
            void guard(() =>
              llms.close(runState.reference, time, {
                type: "_OTHER",
                message: "plugin disposed before message completed",
              }),
            ),
        );
        return options.observer.shutdown();
      });
      return state.shutdown;
    },
    "chat.message": (_input, output) =>
      guard(() => observeUserMessage(output.message, output.parts)),
    "chat.params": (input, output) =>
      guard(() => {
        if (state.shutdown) {
          return;
        }

        const runState = activeRunsBySessionID.get(input.sessionID);

        if (runState) {
          llms.observeRequestParameters(runState.reference, input, output);
        }
      }),
    "chat.headers": (input, output) =>
      guard(() => {
        if (state.shutdown) {
          return;
        }

        const runState = activeRunsBySessionID.get(input.sessionID);
        if (runState) {
          associatePendingLlms(runState.reference);
        }

        const headers = runState ? llms.prepareTraceHeaders(runState.reference, input) : undefined;
        Object.assign(
          output.headers,
          headers && userIdentity?.enabled
            ? { ...headers, tracestate: withUserTraceState(headers.tracestate, userIdentity.id) }
            : headers,
        );
        state.sdkModelCapture?.attachCorrelationHeader(input, output);
        if (fetchCapture && headers && runState) {
          const capture = llms.bindFetch(runState.reference, input);
          if (capture) {
            fetchCapture.bind(headers.traceparent, capture);
          }
        }
      }),
    event: (input: { event: OpenCodeEvent }) =>
      guard(async () => {
        if (state.shutdown) {
          return;
        }

        const event = input.event;
        const time = now();

        switch (event.type) {
          case "session.created":
          case "session.updated": {
            sessionRegistry.observe(event.properties.info);
            return;
          }

          case "permission.asked": {
            const runState = activeRunsBySessionID.get(event.properties.sessionID);

            if (runState) {
              const tool = event.properties.tool;
              permissions.observeRequest(
                runState.reference,
                event.properties,
                time,
                tool
                  ? tools.activeStart(runState.reference, tool.messageID, tool.callID)
                  : undefined,
              );
            }
            return;
          }

          case "permission.replied": {
            const runState = activeRunsBySessionID.get(event.properties.sessionID);
            const requestID =
              "requestID" in event.properties
                ? event.properties.requestID
                : event.properties.permissionID;
            const reply =
              "reply" in event.properties ? event.properties.reply : event.properties.response;

            if (runState && (reply === "once" || reply === "always" || reply === "reject")) {
              const rejectedTool = permissions.observeReply(
                runState.reference,
                requestID,
                reply,
                time,
              );

              if (rejectedTool) {
                tools.markPermissionRejected(rejectedTool);
              }
            }
            return;
          }

          case "session.status":
          case "session.idle": {
            if (event.type === "session.status" && event.properties.status.type !== "idle") {
              const runState = activeRunsBySessionID.get(event.properties.sessionID);
              if (runState) {
                llms.status(runState.reference, event.properties.status);
              }
              return;
            }

            finishActiveRun(
              event.properties.sessionID,
              time,
              activeRunsBySessionID.get(event.properties.sessionID)?.pendingOverflowError,
            );
            await options.observer.flush();
            return;
          }

          case "session.error": {
            const id = event.properties.sessionID;
            const runState = id ? activeRunsBySessionID.get(id) : undefined;

            if (!id || !runState) {
              await options.observer.flush();
              return;
            }

            const error = normalizeError(event.properties.error);
            const activeAssistant = llms.activeAssistant(runState.reference);

            if (error.type === "ContextOverflowError" && activeAssistant) {
              runState.overflowTrigger = {
                messageID: activeAssistant.messageID,
                interactionContext: withAgentContext(
                  interactions.resolveByUserMessage(
                    runState.reference,
                    activeAssistant.parentMessageID,
                  ),
                ),
              };
            }

            llms.fail(
              runState.reference,
              time,
              error,
              options.captureContent && options.captureHttpHeaders && activeAssistant
                ? {
                    messageID: activeAssistant.messageID,
                    headers: parseErrorResponseHeaders(event.properties.error),
                  }
                : undefined,
            );

            if (
              error.type === "ContextOverflowError" &&
              !compactions.activeMessageID(runState.reference) &&
              !runState.pendingOverflowError
            ) {
              runState.pendingOverflowError = error;
              await options.observer.flush();
              return;
            }

            finishActiveRun(id, time, error);
            await options.observer.flush();
            return;
          }

          case "session.compacted": {
            const runState = activeRunsBySessionID.get(event.properties.sessionID);

            if (runState && compactions.completeActive(runState.reference, time)) {
              delete runState.pendingOverflowError;
              delete runState.overflowTrigger;
            }
            return;
          }

          case "session.deleted": {
            finishActiveRun(event.properties.info.id, time, {
              type: "_OTHER",
              message: "session deleted before run completed",
            });
            sessionRegistry.remove(event.properties.info.id);
            await options.observer.flush();
            return;
          }

          case "message.updated": {
            const info = event.properties.info;
            const runState = activeRunsBySessionID.get(info.sessionID);

            if (!runState) {
              return;
            }

            interactions.message(runState.reference, info);

            if (
              info.role === "assistant" &&
              !info.summary &&
              info.error &&
              normalizeError(info.error).type === "ContextOverflowError"
            ) {
              runState.overflowTrigger = {
                messageID: info.id,
                interactionContext: withAgentContext(
                  interactions.resolveByUserMessage(runState.reference, info.parentID),
                ),
              };
            }

            llms.message(
              runState.reference,
              info,
              time,
              info.role === "assistant" ? resolveModelContext(runState.reference, info) : undefined,
            );
            associatePendingTools(runState.reference);
            const error = compactions.message(runState.reference, info, time);
            associatePendingCompactions(runState.reference);
            associatePendingLlms(runState.reference);

            if (error) {
              finishActiveRun(info.sessionID, time, error);
            }
            return;
          }

          case "message.part.updated": {
            const part = event.properties.part;
            const runState = activeRunsBySessionID.get(part.sessionID);

            if (!runState) {
              return;
            }

            switch (part.type) {
              case "compaction": {
                compactions.part(runState.reference, part, time, runState.overflowTrigger);
                associatePendingCompactions(runState.reference);
                associatePendingLlms(runState.reference);
                return;
              }

              case "tool": {
                tools.part(
                  runState.reference,
                  part,
                  time,
                  withAgentContext(
                    interactions.resolveByAssistantMessage(runState.reference, part.messageID),
                  ),
                );
                return;
              }

              default: {
                interactions.part(runState.reference, part);
                if (
                  part.type !== "text" ||
                  !interactions.resolveByUserMessage(runState.reference, part.messageID)
                ) {
                  llms.part(
                    runState.reference,
                    part,
                    nonNegativeNumber(
                      "time" in event.properties ? event.properties.time : undefined,
                    ) ?? time,
                  );
                }
                return;
              }
            }
          }

          case "message.part.removed":
          case "message.removed": {
            const runState = activeRunsBySessionID.get(event.properties.sessionID);
            const partID = "partID" in event.properties ? event.properties.partID : undefined;
            if (runState) {
              llms.remove(runState.reference, event.properties.messageID, time, partID);
              tools.remove(runState.reference, event.properties.messageID, time, partID);
              compactions.remove(runState.reference, event.properties.messageID, time, partID);
              interactions.remove(runState.reference, event.properties.messageID, partID);
            }
            return;
          }
        }
      }),
  } satisfies Hooks;

  async function installSdkModelCapture() {
    const { createSdkModelCapture } = await import("../model/ai-sdk.js");

    if (!state.shutdown) {
      state.sdkModelCapture = createSdkModelCapture({
        bind: (input) => {
          const runState = activeRunsBySessionID.get(input.sessionID);
          if (!runState) {
            return;
          }

          associatePendingLlms(runState.reference);
          return llms.bind(runState.reference, input);
        },
        captureContent: options.captureContent ?? false,
        captureHttpHeaders: options.captureHttpHeaders ?? false,
        log,
      });
    }
  }

  function observeUserMessage(info: UserMessage, parts: Part[]) {
    if (state.shutdown) {
      return;
    }

    const texts = parts
      .filter((part) => part.type === "text")
      .filter((part) => !part.synthetic && !part.ignored);
    const hasUserInput =
      texts.length > 0 || parts.some((part) => part.type === "file" || part.type === "subtask");

    if (!hasUserInput) {
      return;
    }

    const input = runs.observeUserInput({
      sessionID: info.sessionID,
      id: info.id,
      createdAt: info.time.created,
      parentTool: sessionRegistry.parentTool(info.sessionID),
      parentSessionID: sessionRegistry.agentContext(info.sessionID).parentSessionID,
      text:
        options.captureContent && texts.length > 0
          ? texts.map((part) => part.text).join("\n")
          : undefined,
    });

    if (!input) {
      return;
    }

    const runState = activeRunsBySessionID.get(info.sessionID) ?? registerRunState(input.reference);
    interactions.start(
      runState.reference,
      info,
      input.text,
      sessionRegistry.agentContext(info.sessionID),
    );
    compactions.message(runState.reference, info, now());
    associatePendingCompactions(runState.reference);
    associatePendingLlms(runState.reference);
    associatePendingTools(runState.reference);
  }

  function withAgentContext(context: InteractionContext | undefined) {
    return context
      ? { ...context, ...sessionRegistry.agentContext(context.reference.run.sessionID) }
      : undefined;
  }

  function resolveModelContext(run: RunReference, info: { parentID: string; summary?: boolean }) {
    return info.summary
      ? compactions.resolveInteraction(run, info.parentID)
      : withAgentContext(interactions.resolveByUserMessage(run, info.parentID));
  }

  function associatePendingLlms(run: RunReference) {
    llms.unresolved(run).forEach((call) => {
      llms.associate(run, call.id, resolveModelContext(run, call));
    });
  }

  function associatePendingTools(run: RunReference) {
    tools.unresolved(run).forEach((call) => {
      const context = withAgentContext(interactions.resolveByAssistantMessage(run, call.messageID));

      if (context) {
        tools.associate(run, call.messageID, call.callID, context);
      }
    });
  }

  function associatePendingCompactions(run: RunReference) {
    compactions.unresolved(run).forEach((compaction) => {
      const context = withAgentContext(
        interactions.resolveByUserMessage(run, compaction.id) ??
          interactions.resolveAt(run, compaction.startedAt),
      );

      if (context) {
        compactions.associate(run, compaction.id, context);
      }
    });
  }

  function registerRunState(reference: RunReference): ActiveRunState {
    interactions.open(reference);
    llms.open(reference);
    tools.open(reference);
    permissions.open(reference);
    compactions.open(reference);
    const runState: ActiveRunState = {
      reference,
      parentTool: sessionRegistry.parentTool(reference.sessionID),
    };
    activeRunsBySessionID.set(reference.sessionID, runState);

    return runState;
  }

  function finishActiveRun(sessionID: string, time: number, error?: ObservationError) {
    const runState = activeRunsBySessionID.get(sessionID);

    if (!runState) {
      return;
    }

    activeRunsBySessionID.delete(sessionID);
    try {
      activeRunsBySessionID.forEach((child) => {
        if (
          child.parentTool?.interaction.run.sessionID === sessionID &&
          child.parentTool.interaction.run.id === runState.reference.id
        ) {
          finishActiveRun(
            child.reference.sessionID,
            time,
            error ?? { type: "_OTHER", message: "parent run ended before subagent completed" },
          );
        }
      });
      permissions.close(runState.reference, time, error);
      llms.close(runState.reference, time, error);
      compactions.close(runState.reference, time, error);
      tools.close(runState.reference, time, error);
      const output = interactions.finishCurrent(runState.reference, time, error);
      runs.finish({ ...runState.reference, endedAt: time, output, error });
    } finally {
      permissions.release(runState.reference);
      llms.release(runState.reference);
      compactions.release(runState.reference);
      tools.release(runState.reference);
      interactions.release(runState.reference);
      runs.release(runState.reference);
      sessionRegistry.unbindRun(runState.reference);
    }
  }

  return {
    hooks,
    startSdkModelCapture() {
      // Native runtime bypasses AI SDK callbacks, so it cannot consume a correlation header.
      const native = ["1", "true", "yes", "on"].includes(
        (process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM ?? "").toLowerCase(),
      );

      if (state.shutdown || native) {
        return Promise.resolve();
      }

      state.sdkModelCaptureSetup ??= installSdkModelCapture();
      return state.sdkModelCaptureSetup;
    },
  };
}
