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
import type { LlmRequest } from "../model/request.js";
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
  userID?: () => string | undefined;
  now?: () => number;
  log?: (error: unknown) => unknown;
};

type SessionState = {
  reference: RunReference;
  interactions: ReturnType<typeof createInteractionTracker>;
  llms: ReturnType<typeof createLlmTracker>;
  tools: ReturnType<typeof createToolTracker>;
  permissions: ReturnType<typeof createPermissionTracker>;
  compactions: ReturnType<typeof createCompactionTracker>;
  parent?: ToolReference;
  overflow?: ObservationError;
  trigger?: { messageID: string; owner?: InteractionOwner };
};

export function createCoordinator(options: CoordinatorOptions) {
  const log = options.log ?? (() => {});
  const guard = createGuard(log);
  const userIdentity = options.userIdentity ? { ...options.userIdentity } : undefined;
  const runs = createRunTracker(options);
  const sessions = new Map<string, SessionState>();
  const registry = createSessionRegistry();
  const state = {
    closed: false,
    shutdown: undefined as Promise<void> | undefined,
    messageCapture: undefined as ReturnType<typeof createModelMessageCapture> | undefined,
    messageCaptureSetup: undefined as Promise<void> | undefined,
  };
  const now = options.now ?? Date.now;
  const hooks = {
    dispose() {
      state.shutdown ??= guard(() => {
        state.closed = true;
        void guard(() => state.messageCapture?.close());
        void guard(() => {
          sessions.forEach((session) => {
            session.llms.clear();
            session.tools.clear();
            session.compactions.clear();
            session.permissions.clear();
          });
          sessions.clear();
          registry.clear();
          runs.close();
        });
        return options.observer.shutdown();
      });
      return state.shutdown;
    },
    "chat.message": (_input, output) =>
      guard(() => {
        if (!state.closed) {
          userMessage(output.message, output.parts);
        }
      }),
    "chat.params": (input, output) => guard(() => request(input, output)),
    "chat.headers": (input, output) =>
      guard(() => {
        if (state.closed) {
          return;
        }

        const headers = prepareModel(input);
        Object.assign(
          output.headers,
          headers && userIdentity?.enabled
            ? { ...headers, tracestate: userTraceState(headers.tracestate, userIdentity.id) }
            : headers,
        );
        state.messageCapture?.attachCorrelationHeader(input, output);
      }),
    event: (input: { event: OpenCodeEvent }) =>
      guard(() => {
        const observedAt = now();
        const source = input.event;

        if (state.closed) {
          return;
        }

        event(source, observedAt);

        if (
          source.type === "session.idle" ||
          source.type === "session.error" ||
          source.type === "session.deleted" ||
          (source.type === "session.status" && source.properties.status.type === "idle")
        ) {
          void guard(() => options.observer.flush());
        }
      }),
  } satisfies Hooks;

  async function installModelMessageCapture() {
    const { createModelMessageCapture } = await import("../model/ai-sdk.js");

    if (!state.closed) {
      state.messageCapture = createModelMessageCapture({
        bind: bindModel,
        captureContent: options.captureContent ?? false,
        log,
      });
    }
  }

  function bindModel(input: LlmRequest[0]) {
    return state.closed ? undefined : sessions.get(input.sessionID)?.llms.bind(input);
  }

  function prepareModel(input: LlmRequest[0]) {
    return state.closed ? undefined : sessions.get(input.sessionID)?.llms.prepare(input, now());
  }

  function request(input: LlmRequest[0], output: LlmRequest[1]) {
    if (!state.closed) {
      sessions.get(input.sessionID)?.llms.request(input, output);
    }
  }

  function userMessage(info: UserMessage, parts: Part[]) {
    if (state.closed) {
      return;
    }

    const texts = parts
      .filter((part) => part.type === "text")
      .filter((part) => !part.synthetic && !part.ignored);
    const hasUserInput =
      texts.length > 0 || parts.some((part) => part.type === "file" || part.type === "subtask");
    const activeSession = sessions.get(info.sessionID);

    if (!hasUserInput) {
      activeSession?.interactions.continuation(info);
      activeSession?.compactions.message(info, now());
      parts
        .filter((part) => part.type === "compaction")
        .forEach((part) => activeSession?.compactions.part(part, now(), activeSession.trigger));
      activeSession?.llms.message(info, now());
      activeSession?.tools.refresh();
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

    const session = activeSession ?? startSession(input.reference);
    session.interactions.start(info, input.text, input.userID);
    session.compactions.message(info, now());
    session.llms.message(info, now());
    session.tools.refresh();
  }

  function startSession(reference: RunReference): SessionState {
    const interactions = createInteractionTracker({
      observer: options.observer,
      run: reference,
      captureContent: options.captureContent,
      identity: () => registry.identity(reference.sessionID),
    });
    const compactions = createCompactionTracker({
      observer: options.observer,
      parent: (id, time) => interactions.resolve(id) ?? interactions.at(time),
      onFinish: (id, time, error) => llms.closeCompaction(id, time, error),
    });
    const llms = createLlmTracker({
      observer: options.observer,
      captureContent: options.captureContent,
      parent: interactions.resolve,
      compaction: compactions.resolve,
    });
    const tools = createToolTracker({
      observer: options.observer,
      captureContent: options.captureContent,
      parent: interactions.resolveAssistant,
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
    const permissions = createPermissionTracker({ observer: options.observer, tool: tools.active });
    const session: SessionState = {
      reference,
      interactions,
      llms,
      tools,
      compactions,
      permissions,
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
    session.permissions.close(time, error);
    session.llms.close(time, error);
    session.compactions.close(time, error);
    session.tools.close(time, error);
    const output = session.interactions.finish(time, error);
    runs.finish({ ...session.reference, endedAt: time, output, error });
  }

  function event(event: OpenCodeEvent, time = now()) {
    if (state.closed) {
      return;
    }

    switch (event.type) {
      case "session.created":
      case "session.updated": {
        registry.observe(event.properties.info);
        return;
      }

      case "permission.asked": {
        sessions.get(event.properties.sessionID)?.permissions.asked(event.properties, time);
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
          const rejected = session.permissions.replied(requestID, reply, time);

          if (rejected) {
            session.tools.reject(rejected);
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
        return;
      }

      case "session.error": {
        const id = event.properties.sessionID;
        const session = id ? sessions.get(id) : undefined;

        if (!id || !session) {
          return;
        }

        const error = errorDetails(event.properties.error);
        const activeRequest = session.llms.activeRequest();

        if (error.type === "ContextOverflowError" && activeRequest) {
          session.trigger = {
            messageID: activeRequest.messageID,
            owner: session.interactions.resolve(activeRequest.ownerMessageID),
          };
        }

        session.llms.fail(
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
          !session.compactions.active() &&
          !session.overflow
        ) {
          session.overflow = error;
          return;
        }

        endSession(id, time, error);
        return;
      }

      case "session.compacted": {
        const session = sessions.get(event.properties.sessionID);

        if (session?.compactions.completed(time)) {
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
        return;
      }

      case "message.updated": {
        const info = event.properties.info;
        const session = sessions.get(info.sessionID);

        if (!session) {
          return;
        }

        session.interactions.message(info);

        if (
          info.role === "assistant" &&
          !info.summary &&
          info.error &&
          errorDetails(info.error).type === "ContextOverflowError"
        ) {
          session.trigger = {
            messageID: info.id,
            owner: session.interactions.resolve(info.parentID),
          };
        }

        session.llms.message(info, time);
        session.tools.refresh();
        const error = session.compactions.message(info, time);
        session.llms.refresh();

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
            session.compactions.part(part, time, session.trigger);
            session.llms.refresh();
            return;
          }

          case "tool": {
            session.tools.part(part, time);
            return;
          }

          default: {
            session.interactions.part(part);
            session.llms.part(part, time);
            return;
          }
        }
      }

      case "message.part.removed":
      case "message.removed": {
        const session = sessions.get(event.properties.sessionID);
        const partID = "partID" in event.properties ? event.properties.partID : undefined;
        session?.llms.remove(event.properties.messageID, time, partID);
        session?.tools.remove(event.properties.messageID, time, partID);
        session?.compactions.remove(event.properties.messageID, time, partID);
        session?.interactions.remove(event.properties.messageID, partID);
        return;
      }
    }
  }

  return {
    hooks,
    startModelMessageCapture() {
      // Native runtime bypasses AI SDK callbacks, so it cannot consume a correlation header.
      const native = ["1", "true", "yes", "on"].includes(
        (process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM ?? "").toLowerCase(),
      );

      if (state.closed || native) {
        return Promise.resolve();
      }

      state.messageCaptureSetup ??= installModelMessageCapture();
      return state.messageCaptureSetup;
    },
  };
}
