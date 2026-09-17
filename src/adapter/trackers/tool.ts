import type { ToolPart } from "@opencode-ai/sdk";
import type {
  Observer,
  ObservationError,
  ToolFinish,
  ToolReference,
  ToolStart,
  RunReference,
} from "../../contract/observer.js";
import type { InteractionContext } from "./interaction.js";
import { createRunScopedStore } from "../shared/runs.js";
import { jsonObject } from "../shared/json.js";

type ToolCall = {
  partID: string;
  messageID: string;
  callID: string;
  toolName: string;
  startedAt: number;
  arguments?: ToolStart["arguments"];
  startSnapshot?: ToolStart;
  completion?: { endedAt: number; observedAt: number; output?: string; error?: string };
  permissionRejected?: boolean;
  childSessionID?: string;
};

export function createToolTracker(options: {
  observer: Observer;
  captureContent?: boolean;
  onFinish(reference: ToolReference, observedAt: number, error?: ObservationError): void;
  onTask(sessionID: string, reference: ToolReference): void;
}) {
  const store = createRunScopedStore(() => ({
    toolCalls: new Map<string, ToolCall>(),
    finishedCallKeys: new Set<string>(),
  }));

  function finish(
    run: RunReference,
    call: ToolCall,
    completion: Omit<ToolFinish, keyof ToolReference>,
    observedAt: number,
  ) {
    const state = store.get(run);

    if (!state || !call.startSnapshot) {
      return;
    }

    const callKey = `${call.messageID}:${call.callID}`;
    state.toolCalls.delete(callKey);
    state.finishedCallKeys.add(callKey);
    const reference = {
      interaction: call.startSnapshot.interaction,
      callID: call.callID,
      messageID: call.messageID,
    };
    options.onFinish(reference, observedAt, completion.error);
    options.observer.finishTool({ ...reference, ...completion });
  }

  function record(run: RunReference, call: ToolCall, context?: InteractionContext) {
    if (!call.startSnapshot && context) {
      call.startSnapshot = {
        interaction: context.reference,
        messageID: call.messageID,
        callID: call.callID,
        name: call.toolName,
        startedAt: call.startedAt,
        arguments: call.arguments,
        agentName: context.agentName,
        agentType: context.agentType,
        parentSessionID: context.parentSessionID,
      };
      options.observer.startTool(call.startSnapshot);
    }

    if (!call.startSnapshot) {
      return;
    }

    options.observer.updateTool({ ...call.startSnapshot, arguments: call.arguments });

    if (!call.completion && call.toolName === "task" && call.childSessionID) {
      options.onTask(call.childSessionID, call.startSnapshot);
    }

    if (call.completion) {
      finish(
        run,
        call,
        {
          endedAt: call.completion.endedAt,
          output: call.completion.output,
          error:
            call.completion.error === undefined
              ? undefined
              : {
                  type: call.permissionRejected ? "PermissionRejectedError" : "ExecutionError",
                  message: call.completion.error,
                },
        },
        call.completion.observedAt,
      );
    }
  }

  return {
    open: store.open,
    release: store.release,
    part(run: RunReference, part: ToolPart, observedAt: number, context?: InteractionContext) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      const callKey = `${part.messageID}:${part.callID}`;
      const existingCall = state.toolCalls.get(callKey);

      if (
        state.finishedCallKeys.has(callKey) ||
        existingCall?.completion ||
        part.state.status === "pending"
      ) {
        return;
      }

      const startedAt = part.state.time.start;

      if (!Number.isFinite(startedAt) || startedAt < 0) {
        return;
      }

      const call = existingCall ?? {
        partID: part.id,
        messageID: part.messageID,
        callID: part.callID,
        toolName: part.tool,
        startedAt,
      };
      state.toolCalls.set(callKey, call);
      call.arguments = options.captureContent ? jsonObject(part.state.input) : undefined;
      call.childSessionID =
        part.state.status === "running" &&
        typeof part.state.metadata?.sessionId === "string" &&
        part.state.metadata.background !== true
          ? part.state.metadata.sessionId
          : undefined;

      if (
        (part.state.status === "completed" || part.state.status === "error") &&
        Number.isFinite(part.state.time.end) &&
        part.state.time.end >= call.startedAt
      ) {
        call.completion ??= {
          endedAt: part.state.time.end,
          observedAt,
          output:
            options.captureContent && part.state.status === "completed"
              ? part.state.output
              : undefined,
          error: part.state.status === "error" ? part.state.error : undefined,
        };
      }

      record(run, call, context);
    },
    unresolved(run: RunReference) {
      return Array.from(store.get(run)?.toolCalls.values() ?? [])
        .filter((call) => !call.startSnapshot)
        .map((call) => ({ messageID: call.messageID, callID: call.callID }));
    },
    associate(run: RunReference, messageID: string, callID: string, context: InteractionContext) {
      const call = store.get(run)?.toolCalls.get(`${messageID}:${callID}`);

      if (call && !call.startSnapshot) {
        record(run, call, context);
      }
    },
    active(run: RunReference, messageID: string, callID: string) {
      return store.get(run)?.toolCalls.get(`${messageID}:${callID}`)?.startSnapshot;
    },
    reject(reference: ToolReference) {
      const call = store
        .get(reference.interaction.run)
        ?.toolCalls.get(`${reference.messageID}:${reference.callID}`);

      if (call?.startSnapshot?.interaction.id === reference.interaction.id) {
        call.permissionRejected = true;
      }
    },
    remove(run: RunReference, messageID: string, time: number, partID?: string) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      state.toolCalls.forEach((call, key) => {
        if (call.messageID === messageID && (partID === undefined || call.partID === partID)) {
          finish(
            run,
            call,
            { endedAt: time, error: { type: "_OTHER", message: "tool removed before completion" } },
            time,
          );
          state.toolCalls.delete(key);
          state.finishedCallKeys.add(key);
        }
      });
    },
    close(run: RunReference, endedAt: number, error?: ObservationError) {
      const state = store.get(run);

      if (!state) {
        return;
      }

      state.toolCalls.forEach((call) =>
        finish(
          run,
          call,
          {
            endedAt,
            error: error ?? { type: "_OTHER", message: "session ended before tool completed" },
          },
          endedAt,
        ),
      );
    },
  };
}
