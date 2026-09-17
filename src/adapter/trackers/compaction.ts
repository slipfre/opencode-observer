import type { AssistantMessage, CompactionPart, UserMessage } from "@opencode-ai/sdk";
import type {
  CompactionFinish,
  CompactionReference,
  Observer,
  ObservationError,
  RunReference,
} from "../../contract/observer.js";
import type { InteractionOwner } from "./interaction.js";
import { createRunStore } from "../shared/runs.js";
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
  onFinish(run: RunReference, id: string, endedAt: number, error?: ObservationError): void;
}) {
  const states = createRunStore(() => ({
    records: new Map<string, Compaction>(),
    users: new Map<string, number>(),
    active: undefined as string | undefined,
  }));

  function record(compaction: Compaction) {
    if (compaction.reference || compaction.ended) {
      return;
    }

    const owner = compaction.owner;

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
    });
  }

  function finish(run: RunReference, endedAt: number, error?: ObservationError) {
    const state = states.get(run);

    if (!state) {
      return false;
    }

    const compaction = state.active ? state.records.get(state.active) : undefined;
    state.active = undefined;

    if (!compaction || compaction.ended) {
      return false;
    }

    compaction.ended = true;
    options.onFinish(run, compaction.id, endedAt, error);

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
    open: states.open,
    release: states.release,
    unresolved(run: RunReference) {
      return Array.from(states.get(run)?.records.values() ?? [])
        .filter((compaction) => !compaction.reference && !compaction.ended)
        .map((compaction) => ({ id: compaction.id, startedAt: compaction.startedAt }));
    },
    associate(run: RunReference, id: string, owner: InteractionOwner) {
      const compaction = states.get(run)?.records.get(id);

      if (compaction && !compaction.reference && !compaction.ended) {
        compaction.owner ??= owner;
        record(compaction);
      }
    },
    active: (run: RunReference) => states.get(run)?.active,
    completed: (run: RunReference, time: number) => finish(run, time),
    part(
      run: RunReference,
      part: CompactionPart & { overflow?: boolean },
      observedAt: number,
      trigger?: { messageID: string; owner?: InteractionOwner },
    ) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      if (state.records.has(part.messageID)) {
        return;
      }

      finish(run, observedAt, {
        type: "_OTHER",
        message: "a new compaction started before the previous compaction completed",
      });
      const compaction: Compaction = {
        id: part.messageID,
        partID: part.id,
        startedAt: state.users.get(part.messageID) ?? observedAt,
        auto: part.auto,
        overflow: part.overflow === true,
        triggerMessageID: part.overflow === true ? trigger?.messageID : undefined,
        owner: part.overflow === true ? trigger?.owner : undefined,
      };
      state.active = part.messageID;
      state.records.set(part.messageID, compaction);
      record(compaction);
    },
    message(run: RunReference, info: UserMessage | AssistantMessage, observedAt: number) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      if (info.role === "user") {
        state.users.set(info.id, info.time.created);
        return;
      }

      const compaction = info.summary ? state.records.get(info.parentID) : undefined;

      if (!compaction || compaction.ended) {
        return;
      }

      if (info.error && state.active === info.parentID) {
        const error = errorDetails(info.error);
        finish(run, observedAt, error);
        return error;
      }

      if (info.time.completed !== undefined) {
        compaction.usage = parseModelUsage(info.tokens);
        compaction.promptTokens = compaction.usage.inputTokens;
        compaction.summaryTokens = nonNegativeInteger(info.tokens?.output);
      }
    },
    resolve(run: RunReference, id: string): InteractionOwner | undefined {
      const state = states.get(run);

      if (!state) {
        return;
      }

      const compaction = state.records.get(id);
      return compaction?.reference && compaction.owner
        ? { ...compaction.owner, input: undefined }
        : undefined;
    },
    remove(run: RunReference, id: string, observedAt: number, partID?: string) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      if (
        state.active === id &&
        (partID === undefined || state.records.get(id)?.partID === partID)
      ) {
        finish(run, observedAt, {
          type: "_OTHER",
          message: "compaction removed before completion",
        });
      }
    },
    close(run: RunReference, observedAt: number, error?: ObservationError) {
      finish(
        run,
        observedAt,
        error ?? { type: "_OTHER", message: "session ended before compaction completed" },
      );
    },
  };
}
