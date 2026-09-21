import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk";
import type {
  AgentContext,
  InteractionReference,
  Observer,
  ObservationError,
  RunReference,
} from "../../contract/observer.js";
import { createRunScopedStore } from "../shared/runs.js";
import { normalizeError } from "../shared/error.js";

type AssistantMessageState = { info?: AssistantMessage; texts: Map<string, string> };

type Interaction = {
  userMessageID: string;
  startedAt: number;
  /** Captured user text; undefined when capture is disabled or the message has no text. */
  userInputText: string | undefined;
  agentName: string;
};

/** Resolved interaction reference, user text, and agent context passed to other trackers. */
export type InteractionContext = AgentContext & {
  reference: InteractionReference;
  userInputText: string | undefined;
};

export function createInteractionTracker(options: {
  observer: Observer;
  captureContent?: boolean;
}) {
  const store = createRunScopedStore(() => ({
    interactions: [] as Interaction[],
    userMessageOwners: new Map<string, Interaction>(),
    assistantMessages: new Map<string, AssistantMessageState>(),
  }));

  function resolveByUserMessage(
    run: RunReference,
    userMessageID: string,
  ): InteractionContext | undefined {
    const interaction = store.get(run)?.userMessageOwners.get(userMessageID);
    return interaction
      ? {
          reference: { run, id: interaction.userMessageID },
          userInputText: interaction.userInputText,
          agentName: interaction.agentName,
        }
      : undefined;
  }

  return {
    open: store.open,
    release: store.release,
    resolveByUserMessage,
    resolveAt(run: RunReference, time: number) {
      const interaction = store
        .get(run)
        ?.interactions.findLast((interaction) => interaction.startedAt <= time);
      return interaction ? resolveByUserMessage(run, interaction.userMessageID) : undefined;
    },
    resolveByAssistantMessage(run: RunReference, messageID: string) {
      const info = store.get(run)?.assistantMessages.get(messageID)?.info;
      const context = info ? resolveByUserMessage(run, info.parentID) : undefined;
      return context && info
        ? {
            ...context,
            agentName: "agent" in info && typeof info.agent === "string" ? info.agent : info.mode,
          }
        : undefined;
    },
    start(
      run: RunReference,
      info: UserMessage,
      userInputText: string | undefined,
      agentContext: AgentContext,
    ) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      const previous = state.interactions.at(-1);

      if (previous) {
        options.observer.finishInteraction({
          run,
          id: previous.userMessageID,
          endedAt: info.time.created,
          status: "superseded",
        });
      }

      const interaction = {
        userMessageID: info.id,
        startedAt: info.time.created,
        userInputText,
        agentName: info.agent,
      };
      state.interactions.push(interaction);
      state.userMessageOwners.set(info.id, interaction);
      options.observer.startInteraction({
        run,
        id: info.id,
        startedAt: info.time.created,
        input: userInputText,
        agentName: info.agent,
        agentType: agentContext.agentType,
        parentSessionID: agentContext.parentSessionID,
      });
    },
    message(run: RunReference, info: UserMessage | AssistantMessage) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      if (info.role === "user") {
        // A late synthetic continuation belongs to the interaction active at its creation time.
        const interaction = state.interactions.findLast(
          (interaction) => interaction.startedAt <= info.time.created,
        );

        if (interaction && !state.userMessageOwners.has(info.id)) {
          state.userMessageOwners.set(info.id, interaction);
        }
        return;
      }

      const message = state.assistantMessages.get(info.id) ?? { texts: new Map<string, string>() };
      state.assistantMessages.set(info.id, { ...message, info });
    },
    part(run: RunReference, part: Part) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      if (
        part.type !== "text" ||
        !options.captureContent ||
        state.userMessageOwners.has(part.messageID)
      ) {
        return;
      }

      const message = state.assistantMessages.get(part.messageID) ?? {
        texts: new Map<string, string>(),
      };

      if (!part.synthetic && !part.ignored) {
        message.texts.set(part.id, part.text);
      }

      if (part.synthetic || part.ignored) {
        message.texts.delete(part.id);
      }

      state.assistantMessages.set(part.messageID, message);
    },
    remove(run: RunReference, messageID: string, partID?: string) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      if (partID !== undefined) {
        state.assistantMessages.get(messageID)?.texts.delete(partID);
        return;
      }

      state.assistantMessages.delete(messageID);
    },
    finishCurrent(run: RunReference, time: number, error?: ObservationError) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      const interaction = state.interactions.at(-1);

      if (!interaction) {
        return;
      }

      const latestMessage = Array.from(state.assistantMessages.values())
        .filter(
          (message) =>
            message.info &&
            !message.info.summary &&
            state.userMessageOwners.get(message.info.parentID)?.userMessageID ===
              interaction.userMessageID,
        )
        .sort((a, b) => (b.info?.time.created ?? 0) - (a.info?.time.created ?? 0))[0];

      if (
        error ||
        latestMessage?.info?.error ||
        latestMessage?.info?.time.completed === undefined ||
        latestMessage.info.finish === "tool-calls"
      ) {
        options.observer.finishInteraction({
          run,
          id: interaction.userMessageID,
          endedAt: time,
          status: "failed",
          error:
            error ??
            (latestMessage?.info?.error
              ? normalizeError(latestMessage.info.error)
              : { type: "_OTHER", message: "session ended before interaction completed" }),
        });
        return;
      }

      const output =
        options.captureContent && latestMessage.texts.size > 0
          ? Array.from(latestMessage.texts.values()).join("\n")
          : undefined;
      options.observer.finishInteraction({
        run,
        id: interaction.userMessageID,
        endedAt: time,
        status: "completed",
        output,
      });
      return output;
    },
  };
}
