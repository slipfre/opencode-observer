import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk";
import type {
  LlmFinish,
  LlmReference,
  LlmUpdate,
  ModelHeaders,
  Observer,
  ObservationError,
} from "../../contract/observer.js";
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
  startedAt?: number;
  reference?: LlmReference;
  result?: Omit<LlmFinish, "interaction" | "id" | "output">;
  stepIDs?: Set<string>;
  previousTextIDs?: Set<string>;
  texts: Map<string, string>;
  capturePending?: boolean;
  generation?: number;
  messages?: Omit<LlmUpdate, "interaction" | "id">;
};

export function createLlmTracker(options: {
  observer: Observer;
  captureContent?: boolean;
  parent: (userMessageID: string) => InteractionOwner | undefined;
  compaction?: (markerID: string) => InteractionOwner | undefined;
}) {
  const calls = new Map<string, LlmCallState>();
  const finished = new Set<string>();
  const closedCompactions = new Set<string>();
  const requests = new Map<string, ReturnType<typeof parseModelRequest>>();

  function record(id: string) {
    const call = calls.get(id);

    if (!call?.info || call.startedAt === undefined) {
      return;
    }

    const parent = resolveParent(call.info);

    if (!parent) {
      return;
    }

    if (!call.reference) {
      const key = JSON.stringify([
        call.info.parentID,
        call.info.providerID,
        call.info.modelID,
        call.info.agentName,
      ]);
      const request = requests.get(key);
      const provider = request?.providerName ?? providerName(call.info.providerID);
      call.reference = { interaction: parent.reference, id };
      requests.delete(key);
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
        userID: parent.userID,
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

      finished.add(id);
      calls.delete(id);
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

  function resolveParent(info: NonNullable<LlmCallState["info"]>) {
    return info.summary ? options.compaction?.(info.parentID) : options.parent(info.parentID);
  }

  function resolveRequest(input: LlmRequest[0]) {
    const candidates = Array.from(calls.entries()).filter(
      ([_id, call]) =>
        !call.result &&
        call.info &&
        call.info.parentID === input.message.id &&
        call.info.agentName === input.agent &&
        call.info.providerID === input.model.providerID &&
        call.info.modelID === input.model.id &&
        call.info.completed === undefined &&
        resolveParent(call.info),
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  function fail(
    endedAt: number,
    error: ObservationError,
    response?: { messageID: string; headers: ModelHeaders | undefined },
  ) {
    calls.forEach((call, id) => {
      if (call.startedAt === undefined) {
        return;
      }

      call.result ??= { endedAt, error };
      if (options.captureContent && response?.messageID === id) {
        call.result.responseHeaders = response.headers;
      }
      call.capturePending = false;
      record(id);
    });
  }

  function invalidate() {
    // Pending SDK callbacks retain bindings after their session or instance ends.
    calls.clear();
  }

  return {
    invalidate,
    refresh() {
      calls.forEach((_call, id) => record(id));
    },
    activeRequest() {
      const activeCalls = Array.from(calls.entries()).filter(
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
    closeCompaction(markerID: string, endedAt: number, error?: ObservationError) {
      calls.forEach((call, id) => {
        if (call.info?.summary && call.info.parentID === markerID) {
          call.result ??= {
            endedAt,
            error: error ?? {
              type: "_OTHER",
              message: "compaction ended before message completed",
            },
          };
          call.capturePending = false;
          record(id);
        }
      });
      closedCompactions.add(markerID);
    },
    prepare(input: LlmRequest[0], observedAt: number) {
      const candidate = resolveRequest(input);

      if (!candidate) {
        return;
      }

      // Headers must reference a span that already exists before provider execution.
      const call = candidate[1];
      call.startedAt ??= observedAt;
      record(candidate[0]);
      return call.reference ? options.observer.llmTraceHeaders(call.reference) : undefined;
    },
    bind(input: LlmRequest[0]): ModelCapture | undefined {
      const candidate = resolveRequest(input);

      if (!candidate) {
        return;
      }

      const call = candidate[1];
      const id = candidate[0];
      const generation = (call.generation ?? 0) + 1;
      call.generation = generation;
      const isActive = () => calls.get(id) === call && call.generation === generation;

      return {
        active: isActive,
        input(value) {
          if (isActive()) {
            call.messages = value;
            call.capturePending = true;
            record(id);
          }
        },
        output(value) {
          if (isActive()) {
            call.messages = { ...call.messages, ...value };
            call.capturePending = false;
            record(id);
          }
        },
      };
    },
    request(input: LlmRequest[0], output: LlmRequest[1]) {
      const key = JSON.stringify([
        input.message.id,
        input.model.providerID,
        input.model.id,
        input.agent,
      ]);
      requests.set(key, parseModelRequest(input, output));
    },
    message(info: UserMessage | AssistantMessage, observedAt: number) {
      if (info.role === "user") {
        calls.forEach((_call, id) => record(id));
        return;
      }

      if (finished.has(info.id)) {
        return;
      }

      if (info.summary && closedCompactions.has(info.parentID)) {
        calls.delete(info.id);
        finished.add(info.id);
        return;
      }

      const call = calls.get(info.id) ?? { texts: new Map<string, string>() };
      calls.set(info.id, call);
      const agent = "agent" in info && typeof info.agent === "string" ? info.agent : info.mode;
      call.info = {
        parentID: info.parentID,
        modelID: info.modelID,
        providerID: info.providerID,
        agentName: agent || undefined,
        completed: info.time.completed,
        summary: info.summary,
      };

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

      record(info.id);
    },
    part(part: Part, observedAt: number) {
      if (
        finished.has(part.messageID) ||
        !["text", "step-start", "step-finish"].includes(part.type)
      ) {
        return;
      }

      if (part.type === "text" && (!options.captureContent || options.parent(part.messageID))) {
        return;
      }

      const call = calls.get(part.messageID) ?? { texts: new Map<string, string>() };
      calls.set(part.messageID, call);

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
          calls.delete(part.messageID);
          finished.add(part.messageID);
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

      record(part.messageID);
    },
    remove(messageID: string, observedAt: number, partID?: string) {
      if (partID !== undefined) {
        calls.get(messageID)?.texts.delete(partID);
        return;
      }

      const call = calls.get(messageID);

      if (call) {
        call.result ??= {
          endedAt: observedAt,
          error: { type: "_OTHER", message: "message removed before model completed" },
        };
        record(messageID);
        calls.delete(messageID);
        finished.add(messageID);
      }
    },
    fail,
    close(endedAt: number, error?: ObservationError) {
      fail(endedAt, error ?? { type: "_OTHER", message: "session ended before message completed" });
      invalidate();
    },
  };
}
