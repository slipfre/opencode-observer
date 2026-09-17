import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk";
import type {
  AgentIdentity,
  InteractionReference,
  Observer,
  ObservationError,
  RunReference,
} from "../../contract/observer.js";
import { createRunStore } from "../shared/runs.js";
import { errorDetails } from "../shared/error.js";

type AssistantState = { info?: AssistantMessage; texts: Map<string, string> };

export type InteractionOwner = AgentIdentity & {
  reference: InteractionReference;
  input: string | undefined;
};

export function createInteractionTracker(options: {
  observer: Observer;
  captureContent?: boolean;
}) {
  const states = createRunStore(() => ({
    inputs: [] as {
      id: string;
      created: number;
      input: string | undefined;
      agentName: string;
    }[],
    owners: new Map<string, string>(),
    assistants: new Map<string, AssistantState>(),
  }));

  function continuation(run: RunReference, info: UserMessage) {
    const state = states.get(run);

    if (!state) {
      return;
    }

    // A late synthetic continuation belongs to the input active at its creation time.
    const owner = state.inputs.findLast((input) => input.created <= info.time.created);

    if (owner && !state.owners.has(info.id)) {
      state.owners.set(info.id, owner.id);
    }
  }

  function resolve(run: RunReference, userMessageID: string): InteractionOwner | undefined {
    const state = states.get(run);

    if (!state) {
      return;
    }

    const owner = state.inputs.find((input) => input.id === state.owners.get(userMessageID));
    return owner
      ? {
          reference: { run, id: owner.id },
          input: owner.input,
          agentName: owner.agentName,
        }
      : undefined;
  }

  return {
    open: states.open,
    release: states.release,
    resolve,
    at(run: RunReference, time: number) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      const owner = state.inputs.findLast((input) => input.created <= time);
      return owner ? resolve(run, owner.id) : undefined;
    },
    resolveAssistant(run: RunReference, messageID: string) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      const info = state.assistants.get(messageID)?.info;
      const owner = info ? resolve(run, info.parentID) : undefined;
      return owner && info
        ? {
            ...owner,
            agentName: "agent" in info && typeof info.agent === "string" ? info.agent : info.mode,
          }
        : undefined;
    },
    start(
      run: RunReference,
      info: UserMessage,
      input: string | undefined,
      identity: AgentIdentity,
    ) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      const previous = state.inputs.at(-1);

      if (previous) {
        options.observer.finishInteraction({
          run,
          id: previous.id,
          endedAt: info.time.created,
          status: "superseded",
        });
      }

      state.inputs.push({
        id: info.id,
        created: info.time.created,
        input,
        agentName: info.agent,
      });
      state.owners.set(info.id, info.id);
      options.observer.startInteraction({
        run,
        id: info.id,
        startedAt: info.time.created,
        input,
        agentName: info.agent,
        agentType: identity.agentType,
        parentSessionID: identity.parentSessionID,
      });
    },
    message(run: RunReference, info: UserMessage | AssistantMessage) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      if (info.role === "user") {
        continuation(run, info);
        return;
      }

      const assistant = state.assistants.get(info.id) ?? { texts: new Map<string, string>() };
      state.assistants.set(info.id, { ...assistant, info });
    },
    part(run: RunReference, part: Part) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      if (part.type !== "text" || !options.captureContent || state.owners.has(part.messageID)) {
        return;
      }

      const assistant = state.assistants.get(part.messageID) ?? {
        texts: new Map<string, string>(),
      };

      if (!part.synthetic && !part.ignored) {
        assistant.texts.set(part.id, part.text);
      }

      if (part.synthetic || part.ignored) {
        assistant.texts.delete(part.id);
      }

      state.assistants.set(part.messageID, assistant);
    },
    remove(run: RunReference, messageID: string, partID?: string) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      if (partID !== undefined) {
        state.assistants.get(messageID)?.texts.delete(partID);
        return;
      }

      state.assistants.delete(messageID);
    },
    finish(run: RunReference, time: number, error?: ObservationError) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      const owner = state.inputs.at(-1);

      if (!owner) {
        return;
      }

      const assistant = Array.from(state.assistants.values())
        .filter(
          (item) =>
            item.info && !item.info.summary && state.owners.get(item.info.parentID) === owner.id,
        )
        .sort((a, b) => (b.info?.time.created ?? 0) - (a.info?.time.created ?? 0))[0];

      if (error || assistant?.info?.error) {
        options.observer.finishInteraction({
          run,
          id: owner.id,
          endedAt: time,
          status: "failed",
          error: error ?? errorDetails(assistant?.info?.error),
        });
        return;
      }

      if (assistant?.info?.time.completed === undefined || assistant.info.finish === "tool-calls") {
        options.observer.finishInteraction({
          run,
          id: owner.id,
          endedAt: time,
          status: "failed",
          error: { type: "_OTHER", message: "session ended before interaction completed" },
        });
        return;
      }

      const output =
        options.captureContent && assistant.texts.size > 0
          ? Array.from(assistant.texts.values()).join("\n")
          : undefined;
      options.observer.finishInteraction({
        run,
        id: owner.id,
        endedAt: assistant.info.time.completed,
        status: "completed",
        output,
      });
      return output;
    },
  };
}
