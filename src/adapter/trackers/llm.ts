import type { AssistantMessage, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk";
import type {
  LlmFinish,
  LlmReference,
  LlmRetry,
  LlmUpdate,
  ModelHeaders,
  Observer,
  ObservationError,
  RunReference,
} from "../../contract/observer.js";
import { createRunScopedStore } from "../shared/runs.js";
import { errorDetails } from "../shared/error.js";
import { nonNegativeNumber } from "../shared/number.js";
import type { ModelCapture } from "../model/ai-sdk.js";
import { parseModelRequest, providerName, type LlmRequest } from "../model/request.js";
import { parseModelUsage } from "../model/usage.js";
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
  prepared?: boolean;
  reference?: LlmReference;
  finishSnapshot?: Omit<LlmFinish, "interaction" | "id" | "output" | "endedAt"> & {
    endedAt?: number;
  };
  startedStepIDs?: Set<string>;
  requestStartedAt?: number;
  firstChunk?: LlmUpdate["firstChunk"];
  previousStepTextPartIDs?: Set<string>;
  textParts: Map<string, string>;
  awaitingSdkOutput?: boolean;
  captureBinding?: symbol;
  pendingUpdate?: Omit<LlmUpdate, "interaction" | "id">;
  pendingRetry?: Omit<LlmRetry, "observedAt">;
  retryAttempt?: number;
  retries?: LlmRetry[];
};

export function createLlmTracker(options: { observer: Observer; captureContent?: boolean }) {
  const store = createRunScopedStore(() => ({
    llmCalls: new Map<string, LlmCall>(),
    finishedMessageIDs: new Set<string>(),
    closedCompactionIDs: new Set<string>(),
    requestSettings: new Map<string, ReturnType<typeof parseModelRequest>>(),
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
      (!call.prepared && !call.startedStepIDs?.size)
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
        input: options.captureContent ? context.userInputText : undefined,
        parameters: request?.parameters,
        agentType: context.agentType,
        parentSessionID: context.parentSessionID,
        compactionID: message.summary ? message.parentMessageID : undefined,
      });
    }

    if (call.pendingUpdate || call.firstChunk) {
      options.observer.updateLlm({
        ...call.reference,
        ...call.pendingUpdate,
        ...(call.firstChunk ? { firstChunk: call.firstChunk } : {}),
      });
      delete call.pendingUpdate;
      delete call.firstChunk;
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
        output:
          options.captureContent && call.textParts.size > 0
            ? Array.from(call.textParts.values()).join("\n")
            : undefined,
      });
    }
  }

  function resolveRequest(run: RunReference, input: LlmRequest[0]) {
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
      if (!call.prepared && !call.startedStepIDs?.size) {
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
      if (options.captureContent && response?.messageID === call.messageID) {
        call.finishSnapshot.responseHeaders = response.headers;
      }
      call.awaitingSdkOutput = false;
      record(run, call.messageID);
    });
  }

  // SDK callbacks retain only identity, never a call record or its content snapshots.
  function capture(run: RunReference, messageID: string, captureBinding: symbol): ModelCapture {
    function currentCall() {
      const call = store.get(run)?.llmCalls.get(messageID);
      return call?.captureBinding === captureBinding ? call : undefined;
    }

    return {
      active: () => currentCall() !== undefined,
      input(value, startedAt) {
        const call = currentCall();

        if (call) {
          // An SDK binding first acquired after a retry or response cannot recover the original start.
          if (!call.startedStepIDs?.size && call.retryAttempt === undefined) {
            call.requestStartedAt ??= nonNegativeNumber(startedAt);
          }
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
    activeRequest(run: RunReference) {
      const activeCalls = Array.from(store.get(run)?.llmCalls.values() ?? []).filter(
        (call) =>
          call.assistantMessage &&
          !call.assistantMessage.summary &&
          (call.prepared || call.startedStepIDs?.size) &&
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
    status(
      run: RunReference,
      status: Exclude<SessionStatus, { type: "idle" }>,
      observedAt: number,
    ) {
      // Status events identify only a session. Never assign a retry to an ambiguous call.
      const candidates = Array.from(store.get(run)?.llmCalls.values() ?? []).filter(
        (call) =>
          call.assistantMessage &&
          call.assistantMessage.completedAt === undefined &&
          call.finishSnapshot?.endedAt === undefined &&
          (call.prepared || call.startedStepIDs?.size),
      );
      const call = candidates.length === 1 ? candidates[0] : undefined;

      if (!call) {
        candidates.forEach((candidate) => {
          delete candidate.pendingRetry;
        });
        return;
      }

      if (status.type === "retry") {
        if (!Number.isSafeInteger(status.attempt) || status.attempt <= (call.retryAttempt ?? 0)) {
          return;
        }

        call.retryAttempt = status.attempt;
        call.pendingRetry = {
          attempt: status.attempt,
          reason: status.message,
          scheduledAt: nonNegativeNumber(status.next),
        };
        return;
      }

      if (!call.pendingRetry) {
        return;
      }

      call.retries = [...(call.retries ?? []), { ...call.pendingRetry, observedAt }];
      delete call.pendingRetry;
      call.pendingUpdate = { ...call.pendingUpdate, retries: call.retries };
      record(run, call.messageID);
    },
    closeCompaction(
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
    prepare(run: RunReference, input: LlmRequest[0]) {
      const call = resolveRequest(run, input);

      if (!call) {
        return;
      }

      // Headers must reference a span that already exists before provider execution.
      call.prepared = true;
      record(run, call.messageID);
      return call.reference ? options.observer.llmTraceHeaders(call.reference) : undefined;
    },
    bind(run: RunReference, input: LlmRequest[0]): ModelCapture | undefined {
      const call = resolveRequest(run, input);

      if (!call) {
        return;
      }

      const captureBinding = Symbol();
      call.captureBinding = captureBinding;
      return capture(run, call.messageID, captureBinding);
    },
    request(run: RunReference, input: LlmRequest[0], output: LlmRequest[1]) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      const requestKey =
        `${input.message.id}:${encodeURIComponent(input.model.providerID)}:` +
        `${encodeURIComponent(input.model.id)}:${encodeURIComponent(input.agent)}`;
      state.requestSettings.set(requestKey, parseModelRequest(input, output));
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
          error: errorDetails(info.error),
          finishReason: info.finish,
          responseHeaders: options.captureContent
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
        if (
          !call.startedStepIDs?.size &&
          call.requestStartedAt !== undefined &&
          observedAt !== undefined &&
          Number.isFinite(observedAt) &&
          observedAt >= call.requestStartedAt
        ) {
          call.firstChunk = { requestStartedAt: call.requestStartedAt, observedAt };
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
        if (!call.prepared && !call.startedStepIDs?.size) {
          state.llmCalls.delete(part.messageID);
          state.finishedMessageIDs.add(part.messageID);
          return;
        }

        call.finishSnapshot ??= {
          finishReason: part.reason || undefined,
          usage: parseModelUsage(part.tokens),
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
