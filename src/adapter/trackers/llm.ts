import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk";
import type {
  LlmFinish,
  LlmReference,
  LlmUpdate,
  ModelHeaders,
  Observer,
  ObservationError,
  RunReference,
} from "../../contract/observer.js";
import { createRunStore } from "../shared/runs.js";
import { errorDetails } from "../shared/error.js";
import { nonNegativeNumber } from "../shared/number.js";
import type { ModelCapture } from "../model/ai-sdk.js";
import { parseModelRequest, providerName, type LlmRequest } from "../model/request.js";
import { parseModelUsage } from "../model/usage.js";
import { parseErrorResponseHeaders } from "../model/headers.js";
import type { InteractionOwner } from "./interaction.js";

type LlmCallState = {
  info?: {
    parentID: string;
    modelID: string;
    providerID: string;
    agentName?: string;
    completed?: number;
    summary?: boolean;
  };
  owner?: InteractionOwner;
  startedAt?: number;
  reference?: LlmReference;
  result?: Omit<LlmFinish, "interaction" | "id" | "output">;
  stepIDs?: Set<string>;
  previousTextIDs?: Set<string>;
  texts: Map<string, string>;
  capturePending?: boolean;
  binding?: symbol;
  messages?: Omit<LlmUpdate, "interaction" | "id">;
};

export function createLlmTracker(options: { observer: Observer; captureContent?: boolean }) {
  const states = createRunStore(() => ({
    calls: new Map<string, LlmCallState>(),
    finished: new Set<string>(),
    closedCompactions: new Set<string>(),
    requests: new Map<string, ReturnType<typeof parseModelRequest>>(),
  }));

  function record(run: RunReference, id: string) {
    const state = states.get(run);

    if (!state) {
      return;
    }

    const call = state.calls.get(id);

    if (!call?.info || call.startedAt === undefined) {
      return;
    }

    const parent = call.owner;

    if (!parent) {
      return;
    }

    if (!call.reference) {
      // Escape free-form names; a missing agent uses an unescaped separator.
      const key =
        `${call.info.parentID}:${encodeURIComponent(call.info.providerID)}:` +
        `${encodeURIComponent(call.info.modelID)}:` +
        (call.info.agentName === undefined ? ":" : encodeURIComponent(call.info.agentName));
      const request = state.requests.get(key);
      const provider = request?.providerName ?? providerName(call.info.providerID);
      call.reference = { interaction: parent.reference, id };
      state.requests.delete(key);
      options.observer.startLlm({
        ...call.reference,
        startedAt: call.startedAt,
        providerID: call.info.providerID,
        providerName: provider,
        model: request?.model ?? call.info.modelID,
        operation:
          request?.operation ??
          (provider === "gcp.gemini" || provider === "gcp.vertex_ai" ? "generate_content" : "chat"),
        stream: true,
        agentName: call.info.agentName,
        input: options.captureContent ? parent.input : undefined,
        parameters: request?.parameters,
        agentType: parent.agentType,
        parentSessionID: parent.parentSessionID,
        compactionID: call.info.summary ? call.info.parentID : undefined,
      });
    }

    if (call.messages) {
      options.observer.updateLlm({ ...call.reference, ...call.messages });
      delete call.messages;
    }

    if (call.result) {
      if (call.capturePending && !call.result.error) {
        return;
      }

      state.finished.add(id);
      state.calls.delete(id);
      options.observer.finishLlm({
        ...call.reference,
        ...call.result,
        output:
          options.captureContent && call.texts.size > 0
            ? Array.from(call.texts.values()).join("\n")
            : undefined,
      });
    }
  }

  function resolveRequest(run: RunReference, input: LlmRequest[0]) {
    const state = states.get(run);

    if (!state) {
      return;
    }

    const candidates = Array.from(state.calls.entries()).filter(
      ([_id, call]) =>
        !call.result &&
        call.info &&
        call.info.parentID === input.message.id &&
        call.info.agentName === input.agent &&
        call.info.providerID === input.model.providerID &&
        call.info.modelID === input.model.id &&
        call.info.completed === undefined &&
        call.owner,
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  function fail(
    run: RunReference,
    endedAt: number,
    error: ObservationError,
    response?: { messageID: string; headers: ModelHeaders | undefined },
  ) {
    const state = states.get(run);

    if (!state) {
      return;
    }

    state.calls.forEach((call, id) => {
      if (call.startedAt === undefined) {
        return;
      }

      call.result ??= { endedAt, error };
      if (options.captureContent && response?.messageID === id) {
        call.result.responseHeaders = response.headers;
      }
      call.capturePending = false;
      record(run, id);
    });
  }

  // SDK callbacks retain only identity, never a call record or its content snapshots.
  function capture(run: RunReference, id: string, binding: symbol): ModelCapture {
    function current() {
      const call = states.get(run)?.calls.get(id);
      return call?.binding === binding ? call : undefined;
    }

    return {
      active: () => current() !== undefined,
      input(value) {
        const call = current();

        if (call) {
          call.messages = value;
          call.capturePending = true;
          record(run, id);
        }
      },
      output(value) {
        const call = current();

        if (call) {
          call.messages = { ...call.messages, ...value };
          call.capturePending = false;
          record(run, id);
        }
      },
    };
  }

  return {
    open: states.open,
    release: states.release,
    unresolved(run: RunReference) {
      return Array.from(states.get(run)?.calls.entries() ?? []).flatMap(([id, call]) =>
        call.info && !call.reference
          ? [{ id, parentID: call.info.parentID, summary: call.info.summary }]
          : [],
      );
    },
    associate(run: RunReference, id: string, owner: InteractionOwner | undefined) {
      const call = states.get(run)?.calls.get(id);

      if (call && !call.reference) {
        call.owner = owner;
        record(run, id);
      }
    },
    activeRequest(run: RunReference) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      const activeCalls = Array.from(state.calls.entries()).filter(
        ([_id, call]) =>
          call.info && !call.info.summary && call.startedAt !== undefined && !call.result,
      );
      return activeCalls.length === 1 && activeCalls[0]?.[1].info
        ? {
            messageID: activeCalls[0][0],
            ownerMessageID: activeCalls[0][1].info.parentID,
          }
        : undefined;
    },
    closeCompaction(
      run: RunReference,
      markerID: string,
      endedAt: number,
      error?: ObservationError,
    ) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      state.calls.forEach((call, id) => {
        if (call.info?.summary && call.info.parentID === markerID) {
          call.result ??= {
            endedAt,
            error: error ?? {
              type: "_OTHER",
              message: "compaction ended before message completed",
            },
          };
          call.capturePending = false;
          record(run, id);
        }
      });
      state.closedCompactions.add(markerID);
    },
    prepare(run: RunReference, input: LlmRequest[0], observedAt: number) {
      const candidate = resolveRequest(run, input);

      if (!candidate) {
        return;
      }

      // Headers must reference a span that already exists before provider execution.
      const call = candidate[1];
      call.startedAt ??= observedAt;
      record(run, candidate[0]);
      return call.reference ? options.observer.llmTraceHeaders(call.reference) : undefined;
    },
    bind(run: RunReference, input: LlmRequest[0]): ModelCapture | undefined {
      const candidate = resolveRequest(run, input);

      if (!candidate) {
        return;
      }

      const binding = Symbol();
      candidate[1].binding = binding;
      return capture(run, candidate[0], binding);
    },
    request(run: RunReference, input: LlmRequest[0], output: LlmRequest[1]) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      const key =
        `${input.message.id}:${encodeURIComponent(input.model.providerID)}:` +
        `${encodeURIComponent(input.model.id)}:${encodeURIComponent(input.agent)}`;
      state.requests.set(key, parseModelRequest(input, output));
    },
    message(
      run: RunReference,
      info: UserMessage | AssistantMessage,
      observedAt: number,
      owner?: InteractionOwner,
    ) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      if (info.role === "user") {
        return;
      }

      if (state.finished.has(info.id)) {
        return;
      }

      if (info.summary && state.closedCompactions.has(info.parentID)) {
        state.calls.delete(info.id);
        state.finished.add(info.id);
        return;
      }

      const call = state.calls.get(info.id) ?? { texts: new Map<string, string>() };
      state.calls.set(info.id, call);
      const agent = "agent" in info && typeof info.agent === "string" ? info.agent : info.mode;
      call.info = {
        parentID: info.parentID,
        modelID: info.modelID,
        providerID: info.providerID,
        agentName: agent || undefined,
        completed: info.time.completed,
        summary: info.summary,
      };

      if (!call.reference) {
        call.owner = owner;
      }

      if (info.error && call.startedAt !== undefined) {
        call.result ??= {
          endedAt: observedAt,
          error: errorDetails(info.error),
          finishReason: info.finish,
          responseHeaders: options.captureContent
            ? parseErrorResponseHeaders(info.error)
            : undefined,
        };
      }

      record(run, info.id);
    },
    part(run: RunReference, part: Part, observedAt: number) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      if (
        state.finished.has(part.messageID) ||
        !["text", "step-start", "step-finish"].includes(part.type)
      ) {
        return;
      }

      if (part.type === "text" && !options.captureContent) {
        return;
      }

      const call = state.calls.get(part.messageID) ?? { texts: new Map<string, string>() };
      state.calls.set(part.messageID, call);

      if (part.type === "text") {
        if (call.previousTextIDs?.has(part.id)) {
          return;
        }

        if (part.synthetic || part.ignored) {
          call.texts.delete(part.id);
        }

        if (!part.synthetic && !part.ignored) {
          call.texts.set(part.id, part.text);
        }
      }

      if (part.type === "step-start") {
        // Repeated steps/retries belong to the same logical request. A step is not an exact attempt boundary.
        if (call.stepIDs?.size && !call.stepIDs.has(part.id)) {
          call.previousTextIDs ??= new Set();
          call.texts.forEach((_text, id) => call.previousTextIDs?.add(id));
          call.texts.clear();
        }

        call.stepIDs ??= new Set();
        call.stepIDs.add(part.id);
        call.startedAt ??= observedAt;
      }

      if (part.type === "step-finish") {
        if (call.startedAt === undefined) {
          state.calls.delete(part.messageID);
          state.finished.add(part.messageID);
          return;
        }

        call.result ??= {
          endedAt: observedAt,
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
      const state = states.get(run);

      if (!state) {
        return;
      }

      if (partID !== undefined) {
        state.calls.get(messageID)?.texts.delete(partID);
        return;
      }

      const call = state.calls.get(messageID);

      if (call) {
        call.result ??= {
          endedAt: observedAt,
          error: { type: "_OTHER", message: "message removed before model completed" },
        };
        record(run, messageID);
        state.calls.delete(messageID);
        state.finished.add(messageID);
      }
    },
    fail,
    close(run: RunReference, endedAt: number, error?: ObservationError) {
      fail(
        run,
        endedAt,
        error ?? { type: "_OTHER", message: "session ended before message completed" },
      );
      states.get(run)?.calls.clear();
    },
  };
}
