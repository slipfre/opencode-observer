import type { AssistantMessage, CompactionPart, UserMessage } from "@opencode-ai/sdk";
import type {
  CompactionFinish,
  CompactionReference,
  Observer,
  ObservationError,
} from "../../contract/observer.js";
import type { InteractionOwner } from "./interaction.js";
import { errorDetails } from "../shared/error.js";
import { nonNegativeInteger } from "../shared/number.js";
import { parseModelUsage } from "../model/usage.js";

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
      trigger?: { messageID: string; owner?: InteractionOwner },
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
        triggerMessageID: part.overflow === true ? trigger?.messageID : undefined,
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
        compaction.usage = parseModelUsage(info.tokens);
        compaction.promptTokens = compaction.usage.inputTokens;
        compaction.summaryTokens = nonNegativeInteger(info.tokens?.output);
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
