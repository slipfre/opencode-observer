import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk";
import type {
  AgentIdentity,
  InteractionReference,
  Observer,
  ObservationError,
  RunReference,
} from "../contract/observer.js";
import { errorDetails } from "./error.js";

type AssistantState = { info?: AssistantMessage; texts: Map<string, string> };

export type InteractionOwner = AgentIdentity & {
  reference: InteractionReference;
  input: string | undefined;
};

export function createInteractionTracker(options: {
  observer: Observer;
  run: RunReference;
  captureContent?: boolean;
  identity?: () => AgentIdentity;
}) {
  const inputs: {
    id: string;
    created: number;
    input: string | undefined;
    userID?: string;
    agentName: string;
  }[] = [];
  const owners = new Map<string, string>();
  const assistants = new Map<string, AssistantState>();

  function continuation(info: UserMessage) {
    // A late synthetic continuation belongs to the input active at its creation time.
    const owner = inputs.findLast((input) => input.created <= info.time.created);

    if (owner && !owners.has(info.id)) {
      owners.set(info.id, owner.id);
    }
  }

  function resolve(userMessageID: string): InteractionOwner | undefined {
    const owner = inputs.find((input) => input.id === owners.get(userMessageID));

    return owner
      ? {
          ...options.identity?.(),
          reference: { run: options.run, id: owner.id },
          input: owner.input,
          userID: owner.userID,
          agentName: owner.agentName,
        }
      : undefined;
  }

  return {
    continuation,
    resolve,
    at(time: number) {
      const owner = inputs.findLast((input) => input.created <= time);

      return owner ? resolve(owner.id) : undefined;
    },
    resolveAssistant(messageID: string) {
      const info = assistants.get(messageID)?.info;
      const owner = info ? resolve(info.parentID) : undefined;

      return owner && info
        ? {
            ...owner,
            agentName: "agent" in info && typeof info.agent === "string" ? info.agent : info.mode,
          }
        : undefined;
    },
    start(info: UserMessage, input: string | undefined, userID?: string) {
      const previous = inputs.at(-1);

      if (previous) {
        options.observer.finishInteraction({
          run: options.run,
          id: previous.id,
          endedAt: info.time.created,
          status: "superseded",
        });
      }

      inputs.push({
        id: info.id,
        created: info.time.created,
        input,
        userID,
        agentName: info.agent,
      });
      owners.set(info.id, info.id);
      options.observer.startInteraction({
        run: options.run,
        id: info.id,
        startedAt: info.time.created,
        input,
        agentName: info.agent,
        userID,
        agentType: options.identity?.().agentType,
        parentSessionID: options.identity?.().parentSessionID,
      });
    },
    message(info: UserMessage | AssistantMessage) {
      if (info.role === "user") {
        continuation(info);

        return;
      }

      const assistant = assistants.get(info.id) ?? { texts: new Map<string, string>() };
      assistants.set(info.id, { ...assistant, info });
    },
    part(part: Part) {
      if (part.type !== "text" || !options.captureContent || owners.has(part.messageID)) {
        return;
      }

      const assistant = assistants.get(part.messageID) ?? { texts: new Map<string, string>() };

      if (!part.synthetic && !part.ignored) {
        assistant.texts.set(part.id, part.text);
      }

      if (part.synthetic || part.ignored) {
        assistant.texts.delete(part.id);
      }

      assistants.set(part.messageID, assistant);
    },
    remove(messageID: string, partID?: string) {
      if (partID !== undefined) {
        assistants.get(messageID)?.texts.delete(partID);

        return;
      }

      assistants.delete(messageID);
    },
    finish(time: number, error?: ObservationError) {
      const owner = inputs.at(-1);

      if (!owner) {
        return;
      }

      const assistant = Array.from(assistants.values())
        .filter(
          (item) => item.info && !item.info.summary && owners.get(item.info.parentID) === owner.id,
        )
        .sort((a, b) => (b.info?.time.created ?? 0) - (a.info?.time.created ?? 0))[0];

      if (error || assistant?.info?.error) {
        options.observer.finishInteraction({
          run: options.run,
          id: owner.id,
          endedAt: time,
          status: "failed",
          error: error ?? errorDetails(assistant?.info?.error),
        });

        return;
      }

      if (assistant?.info?.time.completed === undefined || assistant.info.finish === "tool-calls") {
        options.observer.finishInteraction({
          run: options.run,
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
        run: options.run,
        id: owner.id,
        endedAt: assistant.info.time.completed,
        status: "completed",
        output,
      });

      return output;
    },
  };
}
