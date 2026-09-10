import { ROOT_CONTEXT, type Context } from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type {
  Observer,
  RunFinish,
  RunReference,
  RunStart,
  ToolFinish,
} from "../contract/observer.js";
import { createRunSpans } from "./spans/run.js";
import { createInteractionSpans } from "./spans/interaction.js";
import { createLlmSpans } from "./spans/llm.js";
import { createToolSpans } from "./spans/tool.js";
import { createCompactionSpans } from "./spans/compaction.js";
import { createPermissionSpans } from "./spans/permission.js";
import { operationKey, sameRun } from "./spans/common.js";

export type ObserverOptions = {
  provider: BasicTracerProvider;
  scope: { name: string; version?: string };
  rootContext?: Context;
  tracePrefix?: string;
  captureContent?: boolean;
  spanAttributes?: Record<string, string>;
  now?: () => number;
};

const reservedAttributes = new Set([
  "session.id",
  "opencode.session.parent_id",
  "user.id",
  "opencode.run.id",
  "opencode.interaction.id",
  "opencode.agent.type",
  "error.type",
  "status.code",
  "status.message",
]);

export function createObserver(options: ObserverOptions): Observer {
  const spanOptions = {
    tracer: options.provider.getTracer(options.scope.name, options.scope.version),
    rootContext: options.rootContext ?? ROOT_CONTEXT,
    tracePrefix: options.tracePrefix ?? "opencode.",
    captureContent: options.captureContent ?? false,
    spanAttributes: Object.fromEntries(
      Object.entries(options.spanAttributes ?? {}).filter(
        ([key]) =>
          !reservedAttributes.has(key) &&
          ![
            "openinference.",
            "gen_ai.",
            "opencode.llm.",
            "opencode.provider.",
            "opencode.message.",
            "opencode.compaction.",
            "opencode.permission.",
            "opencode.tool.",
            "http.request.header.",
            "http.response.header.",
          ].some((prefix) => key.startsWith(prefix)),
      ),
    ),
  };
  const runs = createRunSpans({
    ...spanOptions,
    parentContext: (reference) => tools.context(reference, true),
  });
  const interactions = createInteractionSpans({ ...spanOptions, parentContext: runs.context });
  const tools = createToolSpans({ ...spanOptions, parentContext: interactions.context });
  const permissions = createPermissionSpans({ ...spanOptions, parentContext: tools.context });
  const compactions = createCompactionSpans({
    ...spanOptions,
    parentContext: interactions.context,
  });
  const llms = createLlmSpans({
    ...spanOptions,
    parentContext: (input) =>
      input.compactionID
        ? compactions.context({ interaction: input.interaction, id: input.compactionID })
        : interactions.context(input.interaction),
  });
  const activeRuns = new Map<string, { reference: RunReference; parent: RunStart["parent"] }>();
  const state = {
    closed: false,
    flushing: Promise.resolve(),
    shutdown: undefined as Promise<void> | undefined,
  };

  function endRun(input: RunFinish, disposing = false) {
    const key = JSON.stringify([input.sessionID, input.id]);

    if (!activeRuns.delete(key)) {
      return;
    }

    activeRuns.forEach((run) => {
      if (run.parent && sameRun(run.parent.interaction.run, input)) {
        endRun(
          {
            ...run.reference,
            endedAt: input.endedAt,
            output: undefined,
            error: input.error ?? {
              type: "_OTHER",
              message: "parent run ended before subagent completed",
            },
          },
          disposing,
        );
      }
    });
    const error = (kind: string) =>
      disposing
        ? { type: "_OTHER", message: `plugin disposed before ${kind} completed` }
        : input.error;
    permissions.closeRun(
      input,
      input.endedAt,
      disposing
        ? { type: "_OTHER", message: "plugin disposed before permission replied" }
        : input.error,
    );
    llms.closeRun(input, input.endedAt, error("message"));
    compactions.closeRun(input, input.endedAt, error("compaction"));
    tools.closeRun(input, input.endedAt, error("tool"));
    interactions.closeRun(input, input.endedAt, error("interaction"));
    runs.finish(input);
  }

  function finishTool(input: ToolFinish) {
    if (state.closed) {
      return;
    }

    activeRuns.forEach((run) => {
      if (run.parent && operationKey(run.parent) === operationKey(input)) {
        endRun({
          ...run.reference,
          endedAt: input.endedAt,
          output: undefined,
          error: input.error ?? {
            type: "_OTHER",
            message: "task tool ended before subagent completed",
          },
        });
      }
    });
    permissions.closeTool(input, input.endedAt, input.error);
    tools.finish(input);
  }

  return {
    startRun(input) {
      if (!state.closed) {
        if (runs.start(input)) {
          activeRuns.set(JSON.stringify([input.sessionID, input.id]), {
            reference: { sessionID: input.sessionID, id: input.id },
            parent: input.parent
              ? {
                  callID: input.parent.callID,
                  messageID: input.parent.messageID,
                  interaction: {
                    id: input.parent.interaction.id,
                    run: { ...input.parent.interaction.run },
                  },
                }
              : undefined,
          });
        }
      }
    },
    updateRun(input) {
      if (!state.closed) {
        runs.update(input);
      }
    },
    finishRun(input) {
      if (!state.closed) {
        endRun(input);
      }
    },
    finishTool,
    startTool(input) {
      if (!state.closed) {
        tools.start(input);
      }
    },
    updateTool(input) {
      if (!state.closed) {
        tools.update(input);
      }
    },
    startCompaction(input) {
      if (!state.closed) {
        compactions.start(input);
      }
    },
    finishCompaction(input) {
      if (!state.closed) {
        llms.closeCompaction(input.interaction, input.id, input.endedAt, input.error);
        compactions.finish(input);
      }
    },
    startPermission(input) {
      if (!state.closed) {
        permissions.start(input);
      }
    },
    finishPermission(input) {
      if (!state.closed) {
        permissions.finish(input);
      }
    },
    startInteraction(input) {
      if (!state.closed) {
        interactions.start(input);
      }
    },
    finishInteraction(input) {
      if (!state.closed) {
        interactions.finish(input);
      }
    },
    startLlm(input) {
      if (!state.closed) {
        llms.start(input);
      }
    },
    updateLlm(input) {
      if (!state.closed) {
        llms.update(input);
      }
    },
    finishLlm(input) {
      if (!state.closed) {
        llms.finish(input);
      }
    },
    flush() {
      if (state.closed) {
        return state.shutdown ?? Promise.resolve();
      }

      const flushing = state.flushing.then(() => options.provider.forceFlush());
      // Keep the queue usable after a failure; the returned promise still rejects.
      state.flushing = flushing.catch(() => undefined);

      return flushing;
    },
    shutdown() {
      if (state.shutdown) {
        return state.shutdown;
      }

      const endedAt = (options.now ?? Date.now)();
      state.closed = true;
      activeRuns.forEach((run) =>
        endRun(
          {
            ...run.reference,
            endedAt,
            output: undefined,
            error: { type: "_OTHER", message: "plugin disposed before run completed" },
          },
          true,
        ),
      );
      permissions.close(endedAt);
      llms.close(endedAt);
      compactions.close(endedAt);
      tools.close(endedAt);
      interactions.close(endedAt);
      runs.close(endedAt);
      state.shutdown = state.flushing.then(() => options.provider.shutdown());

      return state.shutdown;
    },
  };
}
