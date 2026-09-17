import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { Observer, RunFinish, RunReference, RunStart } from "../contract/observer.js";
import { createRunSpans } from "./spans/run.js";
import { createInteractionSpans } from "./spans/interaction.js";
import { createLlmSpans } from "./spans/llm.js";
import { createToolSpans } from "./spans/tool.js";
import { createCompactionSpans } from "./spans/compaction.js";
import { createPermissionSpans } from "./spans/permission.js";
import { createSpanHistory, operationKey, sameRun } from "./spans/common.js";

export type ObserverOptions = {
  provider: BasicTracerProvider;
  scope: { name: string; version?: string };
  tracePrefix?: string;
  captureContent?: boolean;
  spanAttributes?: Record<string, string>;
  now?: () => number;
};

const reservedAttributes = new Set([
  "session.id",
  "opencode.session.parent_id",
  "opencode.run.id",
  "opencode.interaction.id",
  "opencode.agent.type",
  "error.type",
  "status.code",
  "status.message",
]);

export function createObserver(options: ObserverOptions): Observer {
  const history = createSpanHistory();
  const spanOptions = {
    history,
    tracer: options.provider.getTracer(options.scope.name, options.scope.version),
    rootContext: ROOT_CONTEXT,
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
    shutdown: undefined as Promise<void> | undefined,
  };

  function endRun(input: RunFinish, disposing = false) {
    const key = `${input.sessionID}:${input.id}`;

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
    history.closeRun(input);
    runs.finish(input);
  }

  return {
    startRun(input) {
      if (history.isRunClosed(input) || !runs.start(input)) {
        return;
      }

      activeRuns.set(`${input.sessionID}:${input.id}`, {
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
    },
    updateRun: runs.update,
    finishRun: endRun,
    finishTool(input) {
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
    },
    startTool: tools.start,
    updateTool: tools.update,
    startCompaction: compactions.start,
    finishCompaction(input) {
      llms.closeCompaction(input.interaction, input.id, input.endedAt, input.error);
      compactions.finish(input);
    },
    startPermission: permissions.start,
    finishPermission: permissions.finish,
    startInteraction: interactions.start,
    finishInteraction: interactions.finish,
    startLlm: llms.start,
    llmTraceHeaders: llms.traceHeaders,
    updateLlm: llms.update,
    finishLlm: llms.finish,
    flush() {
      return state.shutdown ?? options.provider.forceFlush();
    },
    shutdown() {
      if (state.shutdown) {
        return state.shutdown;
      }

      const endedAt = (options.now ?? Date.now)();
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
      state.shutdown = options.provider.shutdown();
      return state.shutdown;
    },
  };
}
