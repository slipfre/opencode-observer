import type { ToolPart } from "@opencode-ai/sdk";
import type {
  Observer,
  ObservationError,
  ToolFinish,
  ToolReference,
  ToolStart,
} from "../../contract/observer.js";
import type { InteractionOwner } from "./interaction.js";
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
  parent(messageID: string): InteractionOwner | undefined;
  onFinish(reference: ToolReference, observedAt: number, error?: ObservationError): void;
  onTask(sessionID: string, reference: ToolReference): void;
}) {
  const calls = new Map<string, ToolCallState>();
  const finished = new Set<string>();

  function finish(
    call: ToolCallState,
    result: Omit<ToolFinish, keyof ToolReference>,
    observedAt: number,
  ) {
    if (!call.start) {
      return;
    }

    calls.delete(JSON.stringify([call.messageID, call.callID]));
    finished.add(JSON.stringify([call.messageID, call.callID]));
    const reference = {
      interaction: call.start.interaction,
      callID: call.callID,
      messageID: call.messageID,
    };
    options.onFinish(reference, observedAt, result.error);
    options.observer.finishTool({ ...reference, ...result });
  }

  function record(call: ToolCallState) {
    const owner = options.parent(call.messageID);

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
        userID: owner.userID,
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
    part(part: ToolPart, observedAt: number) {
      const key = JSON.stringify([part.messageID, part.callID]);

      if (finished.has(key) || calls.get(key)?.result || part.state.status === "pending") {
        return;
      }

      const startedAt = part.state.time.start;

      if (!Number.isFinite(startedAt) || startedAt < 0) {
        return;
      }

      const call = calls.get(key) ?? {
        partID: part.id,
        messageID: part.messageID,
        callID: part.callID,
        name: part.tool,
        startedAt,
      };
      calls.set(key, call);
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

      record(call);
    },
    refresh() {
      calls.forEach(record);
    },
    active(messageID: string, callID: string) {
      return calls.get(JSON.stringify([messageID, callID]))?.start;
    },
    reject(reference: ToolReference) {
      const call = calls.get(JSON.stringify([reference.messageID, reference.callID]));

      if (call?.start?.interaction.id === reference.interaction.id) {
        call.rejected = true;
      }
    },
    remove(messageID: string, time: number, partID?: string) {
      calls.forEach((call, key) => {
        if (call.messageID === messageID && (partID === undefined || call.partID === partID)) {
          finish(
            call,
            { endedAt: time, error: { type: "_OTHER", message: "tool removed before completion" } },
            time,
          );
          calls.delete(key);
          finished.add(key);
        }
      });
    },
    close(endedAt: number, error?: ObservationError) {
      calls.forEach((call) =>
        finish(
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
