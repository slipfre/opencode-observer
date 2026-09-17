import type { AssistantMessage, CompactionPart, UserMessage } from "@opencode-ai/sdk";
import type {
  CompactionFinish,
  CompactionReference,
  Observer,
  ObservationError,
  RunReference,
} from "../../contract/observer.js";
import type { InteractionContext } from "./interaction.js";
import { createRunScopedStore } from "../shared/runs.js";
import { errorDetails } from "../shared/error.js";
import { nonNegativeInteger } from "../shared/number.js";
import { parseModelUsage } from "../model/usage.js";

type Compaction = {
  messageID: string;
  partID: string;
  startedAt: number;
  auto: boolean;
  overflow: boolean;
  triggerMessageID?: string;
  interactionContext?: InteractionContext;
  reference?: CompactionReference;
  summaryTokens?: number;
  usage?: CompactionFinish["usage"];
  finished?: boolean;
};

export function createCompactionTracker(options: {
  observer: Observer;
  onFinish(run: RunReference, messageID: string, endedAt: number, error?: ObservationError): void;
}) {
  const store = createRunScopedStore(() => ({
    compactions: new Map<string, Compaction>(),
    userMessageCreationTimes: new Map<string, number>(),
    activeCompaction: undefined as Compaction | undefined,
  }));

  function record(compaction: Compaction) {
    if (compaction.reference || compaction.finished) {
      return;
    }

    const context = compaction.interactionContext;

    if (!context) {
      return;
    }

    compaction.reference = { interaction: context.reference, id: compaction.messageID };
    options.observer.startCompaction({
      ...compaction.reference,
      startedAt: compaction.startedAt,
      auto: compaction.auto,
      overflow: compaction.overflow,
      triggerMessageID: compaction.triggerMessageID,
      agentName: context.agentName,
      agentType: context.agentType,
      parentSessionID: context.parentSessionID,
    });
  }

  function finish(run: RunReference, endedAt: number, error?: ObservationError) {
    const state = store.get(run);

    if (!state) {
      return false;
    }

    const compaction = state.activeCompaction;
    state.activeCompaction = undefined;

    if (!compaction || compaction.finished) {
      return false;
    }

    compaction.finished = true;
    options.onFinish(run, compaction.messageID, endedAt, error);

    if (compaction.reference) {
      options.observer.finishCompaction({
        ...compaction.reference,
        endedAt,
        error,
        promptTokens: error ? undefined : compaction.usage?.inputTokens,
        summaryTokens: error ? undefined : compaction.summaryTokens,
        usage: error ? undefined : compaction.usage,
      });
    }

    return true;
  }

  return {
    open: store.open,
    release: store.release,
    unresolved(run: RunReference) {
      return Array.from(store.get(run)?.compactions.values() ?? [])
        .filter((compaction) => !compaction.reference && !compaction.finished)
        .map((compaction) => ({ id: compaction.messageID, startedAt: compaction.startedAt }));
    },
    associate(run: RunReference, messageID: string, context: InteractionContext) {
      const compaction = store.get(run)?.compactions.get(messageID);

      if (compaction && !compaction.reference && !compaction.finished) {
        compaction.interactionContext ??= context;
        record(compaction);
      }
    },
    active: (run: RunReference) => store.get(run)?.activeCompaction?.messageID,
    completed: (run: RunReference, observedAt: number) => finish(run, observedAt),
    part(
      run: RunReference,
      part: CompactionPart & { overflow?: boolean },
      observedAt: number,
      trigger?: { messageID: string; interactionContext?: InteractionContext },
    ) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      if (state.compactions.has(part.messageID)) {
        return;
      }

      finish(run, observedAt, {
        type: "_OTHER",
        message: "a new compaction started before the previous compaction completed",
      });
      const compaction: Compaction = {
        messageID: part.messageID,
        partID: part.id,
        startedAt: state.userMessageCreationTimes.get(part.messageID) ?? observedAt,
        auto: part.auto,
        overflow: part.overflow === true,
        triggerMessageID: part.overflow === true ? trigger?.messageID : undefined,
        interactionContext: part.overflow === true ? trigger?.interactionContext : undefined,
      };
      state.activeCompaction = compaction;
      state.compactions.set(part.messageID, compaction);
      record(compaction);
    },
    message(run: RunReference, info: UserMessage | AssistantMessage, observedAt: number) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      if (info.role === "user") {
        state.userMessageCreationTimes.set(info.id, info.time.created);
        return;
      }

      const compaction = info.summary ? state.compactions.get(info.parentID) : undefined;

      if (!compaction || compaction.finished) {
        return;
      }

      if (info.error && state.activeCompaction === compaction) {
        const error = errorDetails(info.error);
        finish(run, observedAt, error);
        return error;
      }

      if (info.time.completed !== undefined) {
        compaction.usage = parseModelUsage(info.tokens);
        compaction.summaryTokens = nonNegativeInteger(info.tokens?.output);
      }
    },
    resolve(run: RunReference, messageID: string): InteractionContext | undefined {
      const compaction = store.get(run)?.compactions.get(messageID);
      return compaction?.reference && compaction.interactionContext
        ? { ...compaction.interactionContext, userInputText: undefined }
        : undefined;
    },
    remove(run: RunReference, messageID: string, observedAt: number, partID?: string) {
      const compaction = store.get(run)?.activeCompaction;

      if (
        compaction?.messageID === messageID &&
        (partID === undefined || compaction.partID === partID)
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
