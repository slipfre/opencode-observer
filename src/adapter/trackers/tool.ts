import type { ToolPart } from "@opencode-ai/sdk";
import type {
  Observer,
  ObservationError,
  ToolFinish,
  ToolReference,
  ToolStart,
  RunReference,
} from "../../contract/observer.js";
import type { InteractionOwner } from "./interaction.js";
import { createRunStore } from "../shared/runs.js";
import { jsonObject } from "../shared/json.js";

type ToolCallState = {
  partID: string;
  messageID: string;
  callID: string;
  name: string;
  startedAt: number;
  arguments?: ToolStart["arguments"];
  start?: ToolStart;
  result?: { endedAt: number; observedAt: number; output?: string; error?: string };
  rejected?: boolean;
  childSessionID?: string;
};

export function createToolTracker(options: {
  observer: Observer;
  captureContent?: boolean;
  onFinish(reference: ToolReference, observedAt: number, error?: ObservationError): void;
  onTask(sessionID: string, reference: ToolReference): void;
}) {
  const states = createRunStore(() => ({
    calls: new Map<string, ToolCallState>(),
    finished: new Set<string>(),
  }));

  function finish(
    run: RunReference,
    call: ToolCallState,
    result: Omit<ToolFinish, keyof ToolReference>,
    observedAt: number,
  ) {
    const state = states.get(run);

    if (!state || !call.start) {
      return;
    }

    state.calls.delete(`${call.messageID}:${call.callID}`);
    state.finished.add(`${call.messageID}:${call.callID}`);
    const reference = {
      interaction: call.start.interaction,
      callID: call.callID,
      messageID: call.messageID,
    };
    options.onFinish(reference, observedAt, result.error);
    options.observer.finishTool({ ...reference, ...result });
  }

  function record(run: RunReference, call: ToolCallState, owner?: InteractionOwner) {
    if (!call.start && !owner) {
      return;
    }

    if (!call.start && owner) {
      call.start = {
        interaction: owner.reference,
        messageID: call.messageID,
        callID: call.callID,
        name: call.name,
        startedAt: call.startedAt,
        arguments: call.arguments,
        agentName: owner.agentName,
        agentType: owner.agentType,
        parentSessionID: owner.parentSessionID,
      };
      options.observer.startTool(call.start);
    }

    if (!call.start) {
      return;
    }

    options.observer.updateTool({ ...call.start, arguments: call.arguments });

    if (!call.result && call.name === "task" && call.childSessionID) {
      options.onTask(call.childSessionID, call.start);
    }

    if (call.result) {
      finish(
        run,
        call,
        {
          endedAt: call.result.endedAt,
          output: call.result.output,
          error:
            call.result.error === undefined
              ? undefined
              : {
                  type: call.rejected ? "PermissionRejectedError" : "ExecutionError",
                  message: call.result.error,
                },
        },
        call.result.observedAt,
      );
    }
  }

  return {
    open: states.open,
    release: states.release,
    part(run: RunReference, part: ToolPart, observedAt: number, owner?: InteractionOwner) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      const key = `${part.messageID}:${part.callID}`;

      if (
        state.finished.has(key) ||
        state.calls.get(key)?.result ||
        part.state.status === "pending"
      ) {
        return;
      }

      const startedAt = part.state.time.start;

      if (!Number.isFinite(startedAt) || startedAt < 0) {
        return;
      }

      const call = state.calls.get(key) ?? {
        partID: part.id,
        messageID: part.messageID,
        callID: part.callID,
        name: part.tool,
        startedAt,
      };
      state.calls.set(key, call);
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
        call.result ??= {
          endedAt: part.state.time.end,
          observedAt,
          output:
            options.captureContent && part.state.status === "completed"
              ? part.state.output
              : undefined,
          error: part.state.status === "error" ? part.state.error : undefined,
        };
      }

      record(run, call, owner);
    },
    unresolved(run: RunReference) {
      return Array.from(states.get(run)?.calls.values() ?? [])
        .filter((call) => !call.start)
        .map((call) => ({ messageID: call.messageID, callID: call.callID }));
    },
    associate(run: RunReference, messageID: string, callID: string, owner: InteractionOwner) {
      const call = states.get(run)?.calls.get(`${messageID}:${callID}`);

      if (call && !call.start) {
        record(run, call, owner);
      }
    },
    active(run: RunReference, messageID: string, callID: string) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      return state.calls.get(`${messageID}:${callID}`)?.start;
    },
    reject(reference: ToolReference) {
      const state = states.get(reference.interaction.run);

      if (!state) {
        return;
      }

      const call = state.calls.get(`${reference.messageID}:${reference.callID}`);

      if (call?.start?.interaction.id === reference.interaction.id) {
        call.rejected = true;
      }
    },
    remove(run: RunReference, messageID: string, time: number, partID?: string) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      state.calls.forEach((call, key) => {
        if (call.messageID === messageID && (partID === undefined || call.partID === partID)) {
          finish(
            run,
            call,
            { endedAt: time, error: { type: "_OTHER", message: "tool removed before completion" } },
            time,
          );
          state.calls.delete(key);
          state.finished.add(key);
        }
      });
    },
    close(run: RunReference, endedAt: number, error?: ObservationError) {
      const state = states.get(run);

      if (!state) {
        return;
      }

      state.calls.forEach((call) =>
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
