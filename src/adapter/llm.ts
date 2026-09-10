import type { Hooks } from "@opencode-ai/plugin";
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk";
import type {
  LlmFinish,
  LlmParameters,
  LlmReference,
  LlmStart,
  LlmUpdate,
  Observer,
  ObservationError,
} from "../contract/observer.js";
import { errorDetails } from "./error.js";
import type { ModelCapture } from "./ai-sdk.js";
import type { InteractionOwner } from "./interaction.js";

export type LlmRequest = Parameters<NonNullable<Hooks["chat.params"]>>;

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
  messages?: Pick<LlmUpdate, "input" | "output">;
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
  const requests = new Map<
    string,
    {
      model: string;
      providerName: string;
      operation: LlmStart["operation"];
      parameters: LlmParameters;
    }
  >();

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

  function fail(endedAt: number, error: ObservationError) {
    calls.forEach((call, id) => {
      if (call.startedAt === undefined) {
        return;
      }

      call.result ??= { endedAt, error };
      call.capturePending = false;
      record(id);
    });
  }

  function clear() {
    calls.clear();
    requests.clear();
    finished.clear();
    closedCompactions.clear();
  }

  return {
    clear,
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
    bind(input: LlmRequest[0]): ModelCapture | undefined {
      if (!options.captureContent) {
        return;
      }

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
      const candidate = candidates.length === 1 ? candidates[0] : undefined;

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
            call.messages = { input: value };
            call.capturePending = true;
            record(id);
          }
        },
        output(value) {
          if (isActive()) {
            call.messages = { ...call.messages, output: value };
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
      requests.set(key, {
        model: input.model.api.id,
        providerName: providerName(input.model.providerID, input.model.api.npm),
        operation: ["@ai-sdk/google", "@ai-sdk/google-vertex"].includes(input.model.api.npm)
          ? "generate_content"
          : "chat",
        parameters: {
          temperature: finite(output.temperature),
          topP: finite(output.topP),
          topK: count(output.topK),
          maxTokens: count(output.maxOutputTokens),
        },
      });
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
        if (call.startedAt !== undefined && !call.stepIDs?.has(part.id)) {
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

        const input = count(part.tokens?.input);
        const output = count(part.tokens?.output);
        const reasoning = count(part.tokens?.reasoning);
        const read = count(part.tokens?.cache?.read);
        const write = count(part.tokens?.cache?.write);
        call.result ??= {
          endedAt: observedAt,
          finishReason: part.reason || undefined,
          usage: {
            inputTokens:
              input !== undefined && read !== undefined && write !== undefined
                ? count(input + read + write)
                : undefined,
            outputTokens:
              output !== undefined && reasoning !== undefined
                ? count(output + reasoning)
                : undefined,
            reasoningTokens: reasoning,
            cacheReadTokens: read,
            cacheWriteTokens: write,
          },
          cost: finite(part.cost),
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
      clear();
    },
  };
}

function providerName(id: string, npm?: string) {
  const names: Record<string, string> = {
    openai: "openai",
    anthropic: "anthropic",
    "@ai-sdk/openai": "openai",
    "@ai-sdk/anthropic": "anthropic",
    "@ai-sdk/amazon-bedrock": "aws.bedrock",
    "@ai-sdk/azure": "azure.ai.openai",
    "@ai-sdk/google": "gcp.gemini",
    "@ai-sdk/google-vertex": "gcp.vertex_ai",
    "amazon-bedrock": "aws.bedrock",
    azure: "azure.ai.openai",
    google: "gcp.gemini",
    "google-vertex": "gcp.vertex_ai",
  };

  // An OpenAI-compatible transport does not establish that OpenAI is the provider.
  return names[id] ?? (npm ? names[npm] : undefined) ?? id;
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function count(value: unknown) {
  const number = finite(value);

  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}
