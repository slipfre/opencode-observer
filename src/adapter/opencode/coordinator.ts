import type { Hooks } from "@opencode-ai/plugin";
import type { Event, Part, UserMessage } from "@opencode-ai/sdk";
import type { PermissionRequest } from "@opencode-ai/sdk/v2";
import type {
  Observer,
  ObservationError,
  RunReference,
  ToolReference,
} from "../../contract/observer.js";
import { errorDetails } from "../shared/error.js";
import { createGuard } from "../shared/guard.js";
import type { createModelMessageCapture } from "../model/ai-sdk.js";
import { parseErrorResponseHeaders } from "../model/headers.js";
import { userTraceState } from "../model/trace-state.js";
import { createInteractionTracker, type InteractionOwner } from "../trackers/interaction.js";
import { createLlmTracker } from "../trackers/llm.js";
import { createRunTracker } from "../trackers/run.js";
import { createToolTracker } from "../trackers/tool.js";
import { createCompactionTracker } from "../trackers/compaction.js";
import { createPermissionTracker } from "../trackers/permission.js";
import { createSessionRegistry } from "./session.js";

export type OpenCodeEvent =
  | Event
  | { type: "permission.asked"; properties: PermissionRequest }
  | {
      type: "permission.replied";
      properties: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" };
    }
  | {
      type: "session.error";
      properties: { sessionID?: string; error?: unknown };
    };

export type CoordinatorOptions = {
  observer: Observer;
  captureContent?: boolean;
  userIdentity?: { enabled: boolean; id?: string };
  now?: () => number;
  log?: (error: unknown) => unknown;
};

type SessionState = {
  reference: RunReference;
  parent?: ToolReference;
  overflow?: ObservationError;
  trigger?: { messageID: string; owner?: InteractionOwner };
};

export function createCoordinator(options: CoordinatorOptions) {
  const log = options.log ?? (() => {});
  const guard = createGuard(log);
  const userIdentity = options.userIdentity ? { ...options.userIdentity } : undefined;
  const runs = createRunTracker({
    observer: options.observer,
    captureContent: options.captureContent,
  });
  const sessions = new Map<string, SessionState>();
  const registry = createSessionRegistry();
  const interactions = createInteractionTracker({
    observer: options.observer,
    captureContent: options.captureContent,
  });
  const compactions = createCompactionTracker({
    observer: options.observer,
    onFinish: (run, id, time, error) => llms.closeCompaction(run, id, time, error),
  });
  const llms = createLlmTracker({
    observer: options.observer,
    captureContent: options.captureContent,
  });
  const tools = createToolTracker({
    observer: options.observer,
    captureContent: options.captureContent,
    onTask: registry.bind,
    onFinish(tool, time, error) {
      permissions.closeTool(tool, time, error);
      sessions.forEach((child) => {
        if (
          child.parent?.callID === tool.callID &&
          child.parent.messageID === tool.messageID &&
          child.parent.interaction.id === tool.interaction.id &&
          child.parent.interaction.run.id === tool.interaction.run.id &&
          child.parent.interaction.run.sessionID === tool.interaction.run.sessionID
        ) {
          endSession(
            child.reference.sessionID,
            time,
            error ?? { type: "_OTHER", message: "task tool ended before subagent completed" },
          );
        }
      });
      registry.releaseTool(tool);
    },
  });
  const permissions = createPermissionTracker({ observer: options.observer });
  const state = {
    shutdown: undefined as Promise<void> | undefined,
    messageCapture: undefined as ReturnType<typeof createModelMessageCapture> | undefined,
    messageCaptureSetup: undefined as Promise<void> | undefined,
  };
  const now = options.now ?? Date.now;
  const hooks = {
    dispose() {
      state.shutdown ??= guard(() => {
        void guard(() => state.messageCapture?.close());
        return options.observer.shutdown();
      });
      return state.shutdown;
    },
    "chat.message": (_input, output) => guard(() => userMessage(output.message, output.parts)),
    "chat.params": (input, output) =>
      guard(() => {
        if (state.shutdown) {
          return;
        }

        const session = sessions.get(input.sessionID);

        if (session) {
          llms.request(session.reference, input, output);
        }
      }),
    "chat.headers": (input, output) =>
      guard(() => {
        if (state.shutdown) {
          return;
        }

        const session = sessions.get(input.sessionID);
        if (session) {
          resolveLlms(session.reference);
        }

        const headers = session ? llms.prepare(session.reference, input, now()) : undefined;
        Object.assign(
          output.headers,
          headers && userIdentity?.enabled
            ? { ...headers, tracestate: userTraceState(headers.tracestate, userIdentity.id) }
            : headers,
        );
        state.messageCapture?.attachCorrelationHeader(input, output);
      }),
    event: (input: { event: OpenCodeEvent }) =>
      guard(async () => {
        if (state.shutdown) {
          return;
        }

        const event = input.event;
        const time = now();

        switch (event.type) {
          case "session.created":
          case "session.updated": {
            registry.observe(event.properties.info);
            return;
          }

          case "permission.asked": {
            const session = sessions.get(event.properties.sessionID);

            if (session) {
              const tool = event.properties.tool;
              permissions.asked(
                session.reference,
                event.properties,
                time,
                tool ? tools.active(session.reference, tool.messageID, tool.callID) : undefined,
              );
            }
            return;
          }

          case "permission.replied": {
            const session = sessions.get(event.properties.sessionID);
            const requestID =
              "requestID" in event.properties
                ? event.properties.requestID
                : event.properties.permissionID;
            const reply =
              "reply" in event.properties ? event.properties.reply : event.properties.response;

            if (session && (reply === "once" || reply === "always" || reply === "reject")) {
              const rejected = permissions.replied(session.reference, requestID, reply, time);

              if (rejected) {
                tools.reject(rejected);
              }
            }
            return;
          }

          case "session.status":
          case "session.idle": {
            if (event.type === "session.status" && event.properties.status.type !== "idle") {
              return;
            }

            endSession(
              event.properties.sessionID,
              time,
              sessions.get(event.properties.sessionID)?.overflow,
            );
            await options.observer.flush();
            return;
          }

          case "session.error": {
            const id = event.properties.sessionID;
            const session = id ? sessions.get(id) : undefined;

            if (!id || !session) {
              await options.observer.flush();
              return;
            }

            const error = errorDetails(event.properties.error);
            const activeRequest = llms.activeRequest(session.reference);

            if (error.type === "ContextOverflowError" && activeRequest) {
              session.trigger = {
                messageID: activeRequest.messageID,
                owner: identify(
                  interactions.resolve(session.reference, activeRequest.ownerMessageID),
                ),
              };
            }

            llms.fail(
              session.reference,
              time,
              error,
              options.captureContent && activeRequest
                ? {
                    messageID: activeRequest.messageID,
                    headers: parseErrorResponseHeaders(event.properties.error),
                  }
                : undefined,
            );

            if (
              error.type === "ContextOverflowError" &&
              !compactions.active(session.reference) &&
              !session.overflow
            ) {
              session.overflow = error;
              await options.observer.flush();
              return;
            }

            endSession(id, time, error);
            await options.observer.flush();
            return;
          }

          case "session.compacted": {
            const session = sessions.get(event.properties.sessionID);

            if (session && compactions.completed(session.reference, time)) {
              delete session.overflow;
              delete session.trigger;
            }
            return;
          }

          case "session.deleted": {
            endSession(event.properties.info.id, time, {
              type: "_OTHER",
              message: "session deleted before run completed",
            });
            registry.remove(event.properties.info.id);
            await options.observer.flush();
            return;
          }

          case "message.updated": {
            const info = event.properties.info;
            const session = sessions.get(info.sessionID);

            if (!session) {
              return;
            }

            interactions.message(session.reference, info);

            if (
              info.role === "assistant" &&
              !info.summary &&
              info.error &&
              errorDetails(info.error).type === "ContextOverflowError"
            ) {
              session.trigger = {
                messageID: info.id,
                owner: identify(interactions.resolve(session.reference, info.parentID)),
              };
            }

            llms.message(
              session.reference,
              info,
              time,
              info.role === "assistant" ? modelOwner(session.reference, info) : undefined,
            );
            resolveTools(session.reference);
            const error = compactions.message(session.reference, info, time);
            resolveCompactions(session.reference);
            resolveLlms(session.reference);

            if (error) {
              endSession(info.sessionID, time, error);
            }
            return;
          }

          case "message.part.updated": {
            const part = event.properties.part;
            const session = sessions.get(part.sessionID);

            if (!session) {
              return;
            }

            switch (part.type) {
              case "compaction": {
                compactions.part(session.reference, part, time, session.trigger);
                resolveCompactions(session.reference);
                resolveLlms(session.reference);
                return;
              }

              case "tool": {
                tools.part(
                  session.reference,
                  part,
                  time,
                  identify(interactions.resolveAssistant(session.reference, part.messageID)),
                );
                return;
              }

              default: {
                interactions.part(session.reference, part);
                if (
                  part.type !== "text" ||
                  !interactions.resolve(session.reference, part.messageID)
                ) {
                  llms.part(session.reference, part, time);
                }
                return;
              }
            }
          }

          case "message.part.removed":
          case "message.removed": {
            const session = sessions.get(event.properties.sessionID);
            const partID = "partID" in event.properties ? event.properties.partID : undefined;
            if (session) {
              llms.remove(session.reference, event.properties.messageID, time, partID);
              tools.remove(session.reference, event.properties.messageID, time, partID);
              compactions.remove(session.reference, event.properties.messageID, time, partID);
              interactions.remove(session.reference, event.properties.messageID, partID);
            }
            return;
          }
        }
      }),
  } satisfies Hooks;

  async function installModelMessageCapture() {
    const { createModelMessageCapture } = await import("../model/ai-sdk.js");

    if (!state.shutdown) {
      state.messageCapture = createModelMessageCapture({
        bind: (input) => {
          const session = sessions.get(input.sessionID);
          if (!session) {
            return;
          }

          resolveLlms(session.reference);
          return llms.bind(session.reference, input);
        },
        captureContent: options.captureContent ?? false,
        log,
      });
    }
  }

  function userMessage(info: UserMessage, parts: Part[]) {
    if (state.shutdown) {
      return;
    }

    const texts = parts
      .filter((part) => part.type === "text")
      .filter((part) => !part.synthetic && !part.ignored);
    const hasUserInput =
      texts.length > 0 || parts.some((part) => part.type === "file" || part.type === "subtask");

    if (!hasUserInput) {
      return;
    }

    const input = runs.userInput({
      sessionID: info.sessionID,
      id: info.id,
      createdAt: info.time.created,
      parent: registry.parent(info.sessionID),
      parentSessionID: registry.identity(info.sessionID).parentSessionID,
      text:
        options.captureContent && texts.length > 0
          ? texts.map((part) => part.text).join("\n")
          : undefined,
    });

    if (!input) {
      return;
    }

    const session = sessions.get(info.sessionID) ?? startSession(input.reference);
    interactions.start(session.reference, info, input.text, registry.identity(info.sessionID));
    compactions.message(session.reference, info, now());
    resolveCompactions(session.reference);
    resolveLlms(session.reference);
    resolveTools(session.reference);
  }

  function identify(owner: InteractionOwner | undefined) {
    return owner ? { ...owner, ...registry.identity(owner.reference.run.sessionID) } : undefined;
  }

  function modelOwner(run: RunReference, info: { parentID: string; summary?: boolean }) {
    return info.summary
      ? compactions.resolve(run, info.parentID)
      : identify(interactions.resolve(run, info.parentID));
  }

  function resolveLlms(run: RunReference) {
    llms.unresolved(run).forEach((call) => {
      llms.associate(run, call.id, modelOwner(run, call));
    });
  }

  function resolveTools(run: RunReference) {
    tools.unresolved(run).forEach((call) => {
      const owner = identify(interactions.resolveAssistant(run, call.messageID));

      if (owner) {
        tools.associate(run, call.messageID, call.callID, owner);
      }
    });
  }

  function resolveCompactions(run: RunReference) {
    compactions.unresolved(run).forEach((compaction) => {
      const owner = identify(
        interactions.resolve(run, compaction.id) ?? interactions.at(run, compaction.startedAt),
      );

      if (owner) {
        compactions.associate(run, compaction.id, owner);
      }
    });
  }

  function startSession(reference: RunReference): SessionState {
    interactions.open(reference);
    llms.open(reference);
    tools.open(reference);
    permissions.open(reference);
    compactions.open(reference);
    const session: SessionState = {
      reference,
      parent: registry.parent(reference.sessionID),
    };
    sessions.set(reference.sessionID, session);

    return session;
  }

  function endSession(sessionID: string, time: number, error?: ObservationError) {
    const session = sessions.get(sessionID);

    if (!session) {
      return;
    }

    sessions.delete(sessionID);
    try {
      sessions.forEach((child) => {
        if (
          child.parent?.interaction.run.sessionID === sessionID &&
          child.parent.interaction.run.id === session.reference.id
        ) {
          endSession(
            child.reference.sessionID,
            time,
            error ?? { type: "_OTHER", message: "parent run ended before subagent completed" },
          );
        }
      });
      permissions.close(session.reference, time, error);
      llms.close(session.reference, time, error);
      compactions.close(session.reference, time, error);
      tools.close(session.reference, time, error);
      const output = interactions.finish(session.reference, time, error);
      runs.finish({ ...session.reference, endedAt: time, output, error });
    } finally {
      permissions.release(session.reference);
      llms.release(session.reference);
      compactions.release(session.reference);
      tools.release(session.reference);
      interactions.release(session.reference);
      runs.release(session.reference);
      registry.releaseRun(session.reference);
    }
  }

  return {
    hooks,
    startModelMessageCapture() {
      // Native runtime bypasses AI SDK callbacks, so it cannot consume a correlation header.
      const native = ["1", "true", "yes", "on"].includes(
        (process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM ?? "").toLowerCase(),
      );

      if (state.shutdown || native) {
        return Promise.resolve();
      }

      state.messageCaptureSetup ??= installModelMessageCapture();
      return state.messageCaptureSetup;
    },
  };
}
