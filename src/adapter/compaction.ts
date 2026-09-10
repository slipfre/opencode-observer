import type { AssistantMessage, CompactionPart, UserMessage } from "@opencode-ai/sdk";
import type {
  CompactionFinish,
  CompactionReference,
  Observer,
  ObservationError,
} from "../contract/observer.js";
import type { InteractionOwner } from "./interaction.js";
import { errorDetails } from "./error.js";

type Compaction = {
  id: string;
  partID: string;
  startedAt: number;
  auto: boolean;
  overflow: boolean;
  triggerMessageID?: string;
  owner?: InteractionOwner;
  reference?: CompactionReference;
  promptTokens?: number;
  summaryTokens?: number;
  usage?: CompactionFinish["usage"];
  ended?: boolean;
};

export function createCompactionTracker(options: {
  observer: Observer;
  parent(id: string, time: number): InteractionOwner | undefined;
  onFinish(id: string, endedAt: number, error?: ObservationError): void;
}) {
  const records = new Map<string, Compaction>();
  const users = new Map<string, number>();
  const state = { active: undefined as string | undefined };

  function record(compaction: Compaction) {
    if (compaction.reference || compaction.ended) {
      return;
    }

    const owner = compaction.owner ?? options.parent(compaction.id, compaction.startedAt);

    if (!owner) {
      return;
    }

    compaction.owner = owner;
    compaction.reference = { interaction: owner.reference, id: compaction.id };
    options.observer.startCompaction({
      ...compaction.reference,
      startedAt: compaction.startedAt,
      auto: compaction.auto,
      overflow: compaction.overflow,
      triggerMessageID: compaction.triggerMessageID,
      agentName: owner.agentName,
      agentType: owner.agentType,
      parentSessionID: owner.parentSessionID,
      userID: owner.userID,
    });
  }

  function finish(endedAt: number, error?: ObservationError) {
    const compaction = state.active ? records.get(state.active) : undefined;
    state.active = undefined;

    if (!compaction || compaction.ended) {
      return false;
    }

    compaction.ended = true;
    options.onFinish(compaction.id, endedAt, error);

    if (compaction.reference) {
      options.observer.finishCompaction({
        ...compaction.reference,
        endedAt,
        error,
        promptTokens: error ? undefined : compaction.promptTokens,
        summaryTokens: error ? undefined : compaction.summaryTokens,
        usage: error ? undefined : compaction.usage,
      });
    }

    return true;
  }

  return {
    active: () => state.active,
    completed: (time: number) => finish(time),
    part(
      part: CompactionPart & { overflow?: boolean },
      observedAt: number,
      trigger?: { id: string; owner?: InteractionOwner },
    ) {
      if (records.has(part.messageID)) {
        return;
      }

      finish(observedAt, {
        type: "_OTHER",
        message: "a new compaction started before the previous compaction completed",
      });
      const compaction: Compaction = {
        id: part.messageID,
        partID: part.id,
        startedAt: users.get(part.messageID) ?? observedAt,
        auto: part.auto,
        overflow: part.overflow === true,
        triggerMessageID: part.overflow === true ? trigger?.id : undefined,
        owner: part.overflow === true ? trigger?.owner : undefined,
      };
      state.active = part.messageID;
      records.set(part.messageID, compaction);
      record(compaction);
    },
    message(info: UserMessage | AssistantMessage, observedAt: number) {
      if (info.role === "user") {
        users.set(info.id, info.time.created);
        records.forEach(record);

        return;
      }

      const compaction = info.summary ? records.get(info.parentID) : undefined;

      if (!compaction || compaction.ended) {
        return;
      }

      if (info.error && state.active === info.parentID) {
        const error = errorDetails(info.error);
        finish(observedAt, error);

        return error;
      }

      if (info.time.completed !== undefined) {
        const counts = [info.tokens?.input, info.tokens?.cache?.read, info.tokens?.cache?.write];
        const prompt = counts.every(validCount)
          ? counts.reduce((total, value) => total + value, 0)
          : undefined;
        compaction.promptTokens = validCount(prompt) ? prompt : undefined;
        compaction.summaryTokens = validCount(info.tokens?.output) ? info.tokens.output : undefined;
        const output = [info.tokens?.output, info.tokens?.reasoning];
        const outputTokens = output.every(validCount)
          ? output.reduce((total, value) => total + value, 0)
          : undefined;
        compaction.usage = {
          inputTokens: compaction.promptTokens,
          outputTokens: validCount(outputTokens) ? outputTokens : undefined,
          reasoningTokens: validCount(info.tokens?.reasoning) ? info.tokens.reasoning : undefined,
          cacheReadTokens: validCount(info.tokens?.cache?.read)
            ? info.tokens.cache.read
            : undefined,
          cacheWriteTokens: validCount(info.tokens?.cache?.write)
            ? info.tokens.cache.write
            : undefined,
        };
      }
    },
    resolve(id: string): InteractionOwner | undefined {
      const compaction = records.get(id);

      return compaction?.reference && compaction.owner
        ? { ...compaction.owner, input: undefined }
        : undefined;
    },
    remove(id: string, observedAt: number, partID?: string) {
      if (state.active === id && (partID === undefined || records.get(id)?.partID === partID)) {
        finish(observedAt, { type: "_OTHER", message: "compaction removed before completion" });
      }
    },
    close(observedAt: number, error?: ObservationError) {
      finish(
        observedAt,
        error ?? { type: "_OTHER", message: "session ended before compaction completed" },
      );
      records.clear();
      users.clear();
    },
    clear() {
      state.active = undefined;
      records.clear();
      users.clear();
    },
  };
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
