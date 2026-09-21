import type { ToolPart } from "@opencode-ai/sdk";
import type {
  Observer,
  ObservationError,
  ToolFinish,
  ToolReference,
  ToolStart,
  RunReference,
  SkillMetadata,
} from "../../contract/observer.js";
import type { InteractionContext } from "./interaction.js";
import { createRunScopedStore } from "../shared/runs.js";
import { toJsonObject } from "../shared/json.js";

type ToolCall = {
  partID: string;
  messageID: string;
  callID: string;
  toolName: string;
  startedAt: number;
  arguments?: ToolStart["arguments"];
  description?: string;
  skill?: SkillMetadata;
  startSnapshot?: ToolStart;
  completion?: { endedAt: number; observedAt: number; output?: string; error?: string };
  permissionRejected?: boolean;
  childSessionID?: string;
};

export function createToolTracker(options: {
  observer: Observer;
  captureContent?: boolean;
  onStart?(tool: ToolStart): void;
  onFinish(reference: ToolReference, observedAt: number, error?: ObservationError): void;
  onChildSessionObserved(sessionID: string, reference: ToolReference): void;
}) {
  const store = createRunScopedStore(() => ({
    toolCalls: new Map<string, ToolCall>(),
    finishedCallKeys: new Set<string>(),
    pendingDescriptions: new Map<
      string,
      { messageID: string; name: string; description: string }
    >(),
  }));

  function finish(
    run: RunReference,
    call: ToolCall,
    completion: Omit<ToolFinish, keyof ToolReference>,
    observedAt: number,
  ) {
    const state = store.get(run);

    if (!state) {
      return;
    }

    const callKey = `${call.messageID}:${call.callID}`;

    if (!state.toolCalls.delete(callKey)) {
      return;
    }

    state.finishedCallKeys.add(callKey);
    state.pendingDescriptions.delete(callKey);

    // Removed or closed parts cannot acquire an owner and reopen through a late update.
    if (!call.startSnapshot) {
      return;
    }

    const reference = {
      interaction: call.startSnapshot.interaction,
      callID: call.callID,
      messageID: call.messageID,
    };
    options.onFinish(reference, observedAt, completion.error);
    if (call.skill) {
      options.observer.finishSkill({ ...reference, ...completion });
      return;
    }

    options.observer.finishTool({ ...reference, ...completion });
  }

  function record(run: RunReference, call: ToolCall, context?: InteractionContext) {
    if (!call.startSnapshot && context) {
      const start = {
        interaction: context.reference,
        messageID: call.messageID,
        callID: call.callID,
        startedAt: call.startedAt,
        agentName: context.agentName,
        agentType: context.agentType,
        parentSessionID: context.parentSessionID,
      };
      call.startSnapshot = {
        ...start,
        name: call.toolName,
        arguments: call.arguments,
        description: call.description,
      };
      if (call.skill) {
        options.observer.startSkill({ ...start, ...call.skill });
      }

      if (!call.skill) {
        options.observer.startTool(call.startSnapshot);
      }

      options.onStart?.(call.startSnapshot);
    }

    if (!call.startSnapshot) {
      return;
    }

    if (call.skill) {
      options.observer.updateSkill({
        interaction: call.startSnapshot.interaction,
        messageID: call.messageID,
        callID: call.callID,
        ...call.skill,
      });
    }

    if (!call.skill) {
      options.observer.updateTool({
        ...call.startSnapshot,
        arguments: call.arguments,
        description: call.description,
      });
    }

    if (!call.completion && call.toolName === "task" && call.childSessionID) {
      options.onChildSessionObserved(call.childSessionID, call.startSnapshot);
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
    describe(
      run: RunReference,
      messageID: string,
      input: { callID: string; name: string; description: string },
    ) {
      const state = store.get(run);
      const key = `${messageID}:${input.callID}`;
      if (
        !state ||
        !options.captureContent ||
        input.name === "skill" ||
        state.finishedCallKeys.has(key)
      ) {
        return;
      }

      const call = state.toolCalls.get(key);
      if (call) {
        if (call.toolName === input.name && !call.skill && call.description === undefined) {
          call.description = input.description;
          if (call.startSnapshot) {
            options.observer.updateTool({
              interaction: call.startSnapshot.interaction,
              messageID: call.messageID,
              callID: call.callID,
              description: call.description,
            });
          }
        }
        return;
      }

      if (!state.pendingDescriptions.has(key)) {
        state.pendingDescriptions.set(key, {
          messageID,
          name: input.name,
          description: input.description,
        });
      }
      if (state.pendingDescriptions.size > 1024) {
        state.pendingDescriptions.delete(state.pendingDescriptions.keys().next().value!);
      }
    },
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
        skill: part.tool === "skill" ? {} : undefined,
      };
      state.toolCalls.set(callKey, call);
      const description = state.pendingDescriptions.get(callKey);
      state.pendingDescriptions.delete(callKey);
      if (description?.name === call.toolName && !call.skill) {
        call.description ??= description.description;
      }
      call.arguments =
        options.captureContent && !call.skill ? toJsonObject(part.state.input) : undefined;

      if (call.skill) {
        // Whitelist identity independently of content capture; never retain raw skill arguments.
        if (typeof part.state.input.name === "string" && part.state.input.name.length > 0) {
          call.skill.name = part.state.input.name;
        }

        if (part.state.status === "completed") {
          const metadata = part.state.metadata;
          if (typeof metadata.name === "string" && metadata.name.length > 0) {
            call.skill.name = metadata.name;
          }

          if (typeof metadata.dir === "string" && metadata.dir.length > 0) {
            call.skill.directory = metadata.dir;
          }

          if (typeof metadata.truncated === "boolean") {
            call.skill.outputTruncated = metadata.truncated;
          }
        }
      }

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
    activeStart(run: RunReference, messageID: string, callID: string) {
      return store.get(run)?.toolCalls.get(`${messageID}:${callID}`)?.startSnapshot;
    },
    markPermissionRejected(reference: ToolReference) {
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

      if (partID === undefined) {
        state.pendingDescriptions.forEach((description, key) => {
          if (description.messageID === messageID) {
            state.pendingDescriptions.delete(key);
          }
        });
      }

      state.toolCalls.forEach((call) => {
        if (call.messageID === messageID && (partID === undefined || call.partID === partID)) {
          finish(
            run,
            call,
            {
              endedAt: time,
              error: {
                type: "_OTHER",
                message: `${call.skill ? "skill load" : "tool"} removed before completion`,
              },
            },
            time,
          );
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
            error: error ?? {
              type: "_OTHER",
              message: `session ended before ${call.skill ? "skill load" : "tool"} completed`,
            },
          },
          endedAt,
        ),
      );
    },
  };
}
