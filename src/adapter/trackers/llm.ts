import type { AssistantMessage, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk";
import type {
  LlmFinish,
  LlmReference,
  LlmUpdate,
  ModelHeaders,
  Observer,
  ObservationError,
  RunReference,
} from "../../contract/observer.js";
import { createRunScopedStore } from "../shared/runs.js";
import { normalizeError } from "../shared/error.js";
import { nonNegativeNumber } from "../shared/number.js";
import type { ModelCapture } from "../model/ai-sdk.js";
import type { FetchCapture, FetchEndReason } from "../model/fetch.js";
import { parseChatParams, providerName, type ChatParamsHookArgs } from "../model/request.js";
import { normalizeOpenCodeUsage } from "../model/usage.js";
import { parseErrorResponseHeaders } from "../model/headers.js";
import type { InteractionContext } from "./interaction.js";

type LlmCall = {
  messageID: string;
  assistantMessage?: {
    parentMessageID: string;
    modelID: string;
    providerID: string;
    agentName?: string;
    createdAt?: number;
    completedAt?: number;
    finishReason?: string;
    summary?: boolean;
  };
  interactionContext?: InteractionContext;
  requestPreparationObserved?: boolean;
  reference?: LlmReference;
  finishSnapshot?: Omit<LlmFinish, "interaction" | "id" | "fallbackOutputText" | "endedAt"> & {
    endedAt?: number;
  };
  startedStepIDs?: Set<string>;
  firstChunkObservedAt?: number;
  previousStepTextPartIDs?: Set<string>;
  textParts: Map<string, string>;
  awaitingSdkOutput?: boolean;
  captureBinding?: symbol;
  pendingUpdate?: Omit<LlmUpdate, "interaction" | "id">;
  retryCount?: number;
  fetchTiming?: {
    startedAt?: number;
    endedAt?: number;
    endReason?: FetchEndReason;
    pending: Set<symbol>;
    prepared: boolean;
    incomplete?: boolean;
  };
};

export function createLlmTracker(options: {
  observer: Observer;
  captureContent?: boolean;
  captureHttpHeaders?: boolean;
  llmTimingMode?: "message" | "fetch";
  onToolDescription?(
    run: RunReference,
    messageID: string,
    value: Parameters<ModelCapture["toolDescription"]>[0],
  ): void;
}) {
  const store = createRunScopedStore(() => ({
    llmCalls: new Map<string, LlmCall>(),
    finishedMessageIDs: new Set<string>(),
    closedCompactionIDs: new Set<string>(),
    requestSettings: new Map<string, ReturnType<typeof parseChatParams>>(),
  }));

  function record(run: RunReference, messageID: string) {
    const state = store.get(run);

    if (!state) {
      return;
    }

    const call = state.llmCalls.get(messageID);
    const startedAt = call?.assistantMessage?.createdAt;

    if (
      !call?.assistantMessage ||
      startedAt === undefined ||
      (!call.requestPreparationObserved && !call.startedStepIDs?.size)
    ) {
      return;
    }

    const context = call.interactionContext;

    if (!context) {
      return;
    }

    if (!call.reference) {
      const message = call.assistantMessage;
      // Escape free-form names; a missing agent uses an unescaped separator.
      const requestKey =
        `${message.parentMessageID}:${encodeURIComponent(message.providerID)}:` +
        `${encodeURIComponent(message.modelID)}:` +
        (message.agentName === undefined ? ":" : encodeURIComponent(message.agentName));
      const request = state.requestSettings.get(requestKey);
      const provider = request?.providerName ?? providerName(message.providerID);
      call.reference = { interaction: context.reference, id: messageID };
      state.requestSettings.delete(requestKey);
      options.observer.startLlm({
        ...call.reference,
        startedAt,
        providerID: message.providerID,
        providerName: provider,
        model: request?.model ?? message.modelID,
        operation:
          request?.operation ??
          (provider === "gcp.gemini" || provider === "gcp.vertex_ai" ? "generate_content" : "chat"),
        stream: true,
        agentName: message.agentName,
        fallbackInputText: options.captureContent ? context.userInputText : undefined,
        parameters: request?.parameters,
        agentType: context.agentType,
        parentSessionID: context.parentSessionID,
        compactionID: message.summary ? message.parentMessageID : undefined,
      });
    }

    if (call.pendingUpdate || call.firstChunkObservedAt !== undefined) {
      options.observer.updateLlm({
        ...call.reference,
        ...call.pendingUpdate,
        ...(call.firstChunkObservedAt !== undefined
          ? { firstChunkObservedAt: call.firstChunkObservedAt }
          : {}),
      });
      delete call.pendingUpdate;
      delete call.firstChunkObservedAt;
    }

    const endedAt = call.assistantMessage.completedAt ?? call.finishSnapshot?.endedAt;
    if (call.finishSnapshot && endedAt !== undefined) {
      if (call.awaitingSdkOutput && !call.finishSnapshot.error) {
        return;
      }

      state.finishedMessageIDs.add(messageID);
      state.llmCalls.delete(messageID);
      options.observer.finishLlm({
        ...call.reference,
        ...call.finishSnapshot,
        endedAt,
        ...(options.llmTimingMode === "fetch"
          ? {
              timing:
                call.fetchTiming?.startedAt !== undefined &&
                call.fetchTiming.endedAt !== undefined &&
                call.fetchTiming.endedAt >= call.fetchTiming.startedAt &&
                call.fetchTiming.endReason !== undefined &&
                !call.fetchTiming.pending.size &&
                !call.fetchTiming.incomplete &&
                !call.fetchTiming.prepared
                  ? {
                      source: "fetch" as const,
                      startedAt: call.fetchTiming.startedAt,
                      endedAt: call.fetchTiming.endedAt,
                      endReason: call.fetchTiming.endReason,
                    }
                  : {
                      source: "message" as const,
                      fallbackReason:
                        call.fetchTiming?.startedAt === undefined
                          ? ("fetch-unobserved" as const)
                          : ("fetch-incomplete" as const),
                    },
            }
          : {}),
        fallbackOutputText:
          options.captureContent && call.textParts.size > 0
            ? Array.from(call.textParts.values()).join("\n")
            : undefined,
      });
    }
  }

  function findMatchingCall(run: RunReference, input: ChatParamsHookArgs[0]) {
    const candidates = Array.from(store.get(run)?.llmCalls.values() ?? []).filter(
      (call) =>
        !call.finishSnapshot &&
        call.assistantMessage &&
        call.assistantMessage.parentMessageID === input.message.id &&
        call.assistantMessage.agentName === input.agent &&
        call.assistantMessage.providerID === input.model.providerID &&
        call.assistantMessage.modelID === input.model.id &&
        call.assistantMessage.completedAt === undefined &&
        call.interactionContext,
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  function fail(
    run: RunReference,
    endedAt: number,
    error: ObservationError,
    response?: { messageID: string; headers: ModelHeaders | undefined },
  ) {
    const state = store.get(run);

    if (!state) {
      return;
    }

    state.llmCalls.forEach((call) => {
      if (!call.requestPreparationObserved && !call.startedStepIDs?.size) {
        return;
      }

      call.finishSnapshot = {
        ...call.finishSnapshot,
        endedAt: call.finishSnapshot?.endedAt ?? endedAt,
        finishReason: call.finishSnapshot?.finishReason ?? call.assistantMessage?.finishReason,
        error:
          call.finishSnapshot?.error ??
          (call.assistantMessage?.completedAt === undefined ? error : undefined),
      };
      if (
        options.captureContent &&
        options.captureHttpHeaders &&
        response?.messageID === call.messageID
      ) {
        call.finishSnapshot.responseHeaders = response.headers;
      }
      call.awaitingSdkOutput = false;
      record(run, call.messageID);
    });
  }

  // SDK callbacks retain only identity, never a call record or its content snapshots.
  function createCaptureCallbacks(
    run: RunReference,
    messageID: string,
    captureBinding: symbol,
  ): ModelCapture {
    function currentCall() {
      const call = store.get(run)?.llmCalls.get(messageID);
      return call?.captureBinding === captureBinding ? call : undefined;
    }

    return {
      active: () => currentCall() !== undefined,
      input(value) {
        const call = currentCall();

        if (call) {
          call.pendingUpdate = value;
          call.awaitingSdkOutput = true;
          record(run, messageID);
        }
      },
      output(value) {
        const call = currentCall();

        if (call) {
          call.pendingUpdate = { ...call.pendingUpdate, ...value };
          call.awaitingSdkOutput = false;
          record(run, messageID);
        }
      },
      toolDescription(value) {
        if (currentCall() && options.captureContent) {
          options.onToolDescription?.(run, messageID, value);
        }
      },
    };
  }

  return {
    open: store.open,
    release: store.release,
    unresolved(run: RunReference) {
      return Array.from(store.get(run)?.llmCalls.values() ?? []).flatMap((call) =>
        call.assistantMessage && !call.reference
          ? [
              {
                id: call.messageID,
                parentID: call.assistantMessage.parentMessageID,
                summary: call.assistantMessage.summary,
              },
            ]
          : [],
      );
    },
    associate(run: RunReference, messageID: string, context: InteractionContext | undefined) {
      const call = store.get(run)?.llmCalls.get(messageID);

      if (call && !call.reference) {
        call.interactionContext = context;
        record(run, messageID);
      }
    },
    activeAssistant(run: RunReference) {
      const activeCalls = Array.from(store.get(run)?.llmCalls.values() ?? []).filter(
        (call) =>
          call.assistantMessage &&
          !call.assistantMessage.summary &&
          (call.requestPreparationObserved || call.startedStepIDs?.size) &&
          !call.finishSnapshot,
      );
      const call = activeCalls.length === 1 ? activeCalls[0] : undefined;
      return call?.assistantMessage
        ? {
            messageID: call.messageID,
            parentMessageID: call.assistantMessage.parentMessageID,
          }
        : undefined;
    },
    status(run: RunReference, status: Exclude<SessionStatus, { type: "idle" }>) {
      if (status.type !== "retry") {
        return;
      }

      // Status events identify only a session. Never assign a retry to an ambiguous call.
      const candidates = Array.from(store.get(run)?.llmCalls.values() ?? []).filter(
        (call) =>
          call.assistantMessage &&
          call.assistantMessage.completedAt === undefined &&
          call.finishSnapshot?.endedAt === undefined &&
          (call.requestPreparationObserved || call.startedStepIDs?.size),
      );
      const call = candidates.length === 1 ? candidates[0] : undefined;

      if (
        !call ||
        !Number.isSafeInteger(status.attempt) ||
        status.attempt <= (call.retryCount ?? 0)
      ) {
        return;
      }

      call.retryCount = status.attempt;
      call.pendingUpdate = { ...call.pendingUpdate, retryCount: call.retryCount };
      record(run, call.messageID);
    },
    finishForCompaction(
      run: RunReference,
      markerID: string,
      endedAt: number,
      error?: ObservationError,
    ) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      state.llmCalls.forEach((call) => {
        if (call.assistantMessage?.summary && call.assistantMessage.parentMessageID === markerID) {
          call.finishSnapshot = {
            ...call.finishSnapshot,
            endedAt: call.finishSnapshot?.endedAt ?? endedAt,
            error:
              call.finishSnapshot?.error ??
              (call.assistantMessage.completedAt === undefined
                ? (error ?? {
                    type: "_OTHER",
                    message: "compaction ended before message completed",
                  })
                : undefined),
          };
          call.awaitingSdkOutput = false;
          record(run, call.messageID);
        }
      });
      state.closedCompactionIDs.add(markerID);
    },
    prepareTraceHeaders(run: RunReference, input: ChatParamsHookArgs[0]) {
      const call = findMatchingCall(run, input);

      if (!call) {
        return;
      }

      // Headers must reference a span that already exists before provider execution.
      call.requestPreparationObserved = true;
      record(run, call.messageID);
      return call.reference ? options.observer.llmTraceHeaders(call.reference) : undefined;
    },
    bind(run: RunReference, input: ChatParamsHookArgs[0]): ModelCapture | undefined {
      const call = findMatchingCall(run, input);

      if (!call) {
        return;
      }

      const captureBinding = Symbol();
      call.captureBinding = captureBinding;
      return createCaptureCallbacks(run, call.messageID, captureBinding);
    },
    bindFetch(run: RunReference, input: ChatParamsHookArgs[0]): FetchCapture | undefined {
      const call = findMatchingCall(run, input);
      if (!call) {
        return;
      }

      const messageID = call.messageID;
      if (call.fetchTiming?.prepared) {
        // A later preparation cannot recover an earlier request that bypassed the wrapper.
        call.fetchTiming.incomplete = true;
      }
      call.fetchTiming ??= { pending: new Set(), prepared: true };
      call.fetchTiming.prepared = true;
      return {
        active: () => store.get(run)?.llmCalls.has(messageID) ?? false,
        start(time) {
          const timing = store.get(run)?.llmCalls.get(messageID)?.fetchTiming;
          if (!timing || nonNegativeNumber(time) === undefined) {
            return () => {};
          }

          const request = Symbol();
          timing.startedAt ??= time;
          timing.pending.add(request);
          timing.prepared = false;
          return (endedAt, reason) => {
            const latest = store.get(run)?.llmCalls.get(messageID)?.fetchTiming;
            if (latest !== timing || !latest.pending.delete(request)) {
              return;
            }

            if (Number.isFinite(endedAt) && endedAt >= time && endedAt >= (latest.endedAt ?? 0)) {
              latest.endedAt = endedAt;
              latest.endReason = reason;
              return;
            }
            latest.incomplete = true;
          };
        },
      };
    },
    observeRequestParameters(
      run: RunReference,
      input: ChatParamsHookArgs[0],
      output: ChatParamsHookArgs[1],
    ) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      const requestKey =
        `${input.message.id}:${encodeURIComponent(input.model.providerID)}:` +
        `${encodeURIComponent(input.model.id)}:${encodeURIComponent(input.agent)}`;
      state.requestSettings.set(requestKey, parseChatParams(input, output));
    },
    message(
      run: RunReference,
      info: UserMessage | AssistantMessage,
      observedAt: number,
      context?: InteractionContext,
    ) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      if (info.role === "user") {
        return;
      }

      if (state.finishedMessageIDs.has(info.id)) {
        return;
      }

      if (info.summary && state.closedCompactionIDs.has(info.parentID)) {
        state.llmCalls.delete(info.id);
        state.finishedMessageIDs.add(info.id);
        return;
      }

      const call = state.llmCalls.get(info.id) ?? {
        messageID: info.id,
        textParts: new Map<string, string>(),
      };
      state.llmCalls.set(info.id, call);
      const agent = "agent" in info && typeof info.agent === "string" ? info.agent : info.mode;
      call.assistantMessage = {
        parentMessageID: info.parentID,
        modelID: info.modelID,
        providerID: info.providerID,
        agentName: agent || undefined,
        createdAt: call.assistantMessage?.createdAt ?? nonNegativeNumber(info.time.created),
        completedAt:
          call.assistantMessage?.completedAt ??
          (info.time.completed !== undefined && info.time.completed >= info.time.created
            ? nonNegativeNumber(info.time.completed)
            : undefined),
        finishReason: info.finish || call.assistantMessage?.finishReason,
        summary: info.summary,
      };

      if (!call.reference) {
        call.interactionContext = context;
      }

      if (info.error) {
        call.finishSnapshot = {
          ...call.finishSnapshot,
          endedAt: call.finishSnapshot?.endedAt ?? observedAt,
          error: normalizeError(info.error),
          finishReason: info.finish,
          responseHeaders:
            options.captureContent && options.captureHttpHeaders
              ? parseErrorResponseHeaders(info.error)
              : undefined,
        };
      }

      record(run, info.id);
    },
    part(run: RunReference, part: Part, observedAt?: number) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      if (
        state.finishedMessageIDs.has(part.messageID) ||
        !["text", "step-start", "step-finish"].includes(part.type)
      ) {
        return;
      }

      if (part.type === "text" && !options.captureContent) {
        return;
      }

      const call = state.llmCalls.get(part.messageID) ?? {
        messageID: part.messageID,
        textParts: new Map<string, string>(),
      };
      state.llmCalls.set(part.messageID, call);

      if (part.type === "text") {
        if (call.previousStepTextPartIDs?.has(part.id)) {
          return;
        }

        if (part.synthetic || part.ignored) {
          call.textParts.delete(part.id);
        }

        if (!part.synthetic && !part.ignored) {
          call.textParts.set(part.id, part.text);
        }
      }

      if (part.type === "step-start") {
        if (call.assistantMessage?.completedAt !== undefined && call.startedStepIDs?.size) {
          return;
        }

        // Only the first step estimates first chunk arrival; retries and duplicate events cannot replace it.
        if (!call.startedStepIDs?.size) {
          call.firstChunkObservedAt = nonNegativeNumber(observedAt);
        }

        // Repeated steps/retries belong to the same logical request. A step is not an exact attempt boundary.
        if (call.startedStepIDs?.size && !call.startedStepIDs.has(part.id)) {
          if (call.finishSnapshot?.endedAt === undefined) {
            delete call.finishSnapshot;
          }
          call.previousStepTextPartIDs ??= new Set();
          call.textParts.forEach((_text, partID) => call.previousStepTextPartIDs?.add(partID));
          call.textParts.clear();
        }

        call.startedStepIDs ??= new Set();
        call.startedStepIDs.add(part.id);
      }

      if (part.type === "step-finish") {
        if (!call.requestPreparationObserved && !call.startedStepIDs?.size) {
          state.llmCalls.delete(part.messageID);
          state.finishedMessageIDs.add(part.messageID);
          return;
        }

        call.finishSnapshot ??= {
          finishReason: part.reason || undefined,
          usage: normalizeOpenCodeUsage(part.tokens),
          cost: nonNegativeNumber(part.cost),
          ...(part.reason === "error"
            ? { error: { type: "_OTHER", message: "model generation ended with error" } }
            : {}),
        };
      }

      record(run, part.messageID);
    },
    remove(run: RunReference, messageID: string, observedAt: number, partID?: string) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      if (partID !== undefined) {
        state.llmCalls.get(messageID)?.textParts.delete(partID);
        return;
      }

      const call = state.llmCalls.get(messageID);

      if (call) {
        call.finishSnapshot = {
          ...call.finishSnapshot,
          endedAt: call.finishSnapshot?.endedAt ?? observedAt,
          error:
            call.finishSnapshot?.error ??
            (call.assistantMessage?.completedAt === undefined
              ? { type: "_OTHER", message: "message removed before model completed" }
              : undefined),
        };
        call.awaitingSdkOutput = false;
        record(run, messageID);
        state.llmCalls.delete(messageID);
        state.finishedMessageIDs.add(messageID);
      }
    },
    fail,
    close(run: RunReference, endedAt: number, error?: ObservationError) {
      fail(
        run,
        endedAt,
        error ?? { type: "_OTHER", message: "session ended before message completed" },
      );
      store.get(run)?.llmCalls.clear();
    },
  };
}
