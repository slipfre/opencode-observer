import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { Observer, RunFinish, RunReference, RunStart } from "../contract/observer.js";
import { createRunSpans } from "./spans/run.js";
import { createInteractionSpans } from "./spans/interaction.js";
import { createLlmSpans } from "./spans/llm.js";
import { createToolSpans } from "./spans/tool.js";
import { createSkillSpans } from "./spans/skill.js";
import { createCompactionSpans } from "./spans/compaction.js";
import { createPermissionSpans } from "./spans/permission.js";
import { createFinishedSpanRegistry, operationKey, sameRun } from "./spans/common.js";

export type ObserverOptions = {
  tracerProvider: BasicTracerProvider;
  instrumentationScope: { name: string; version?: string };
  spanNamePrefix?: string;
  attributePrefix?: string;
  captureContent?: boolean;
  captureHttpHeaders?: boolean;
  spanAttributes?: Record<string, string>;
  now?: () => number;
  spanStartTimes?: WeakMap<object, number>;
};

export function createObserver(options: ObserverOptions): Observer {
  const attributePrefix = options.attributePrefix ?? "opencode.";
  // Protect both schema spellings without reserving the whole configurable namespace.
  const reservedAttributes = new Set([
    "session.id",
    "ai.agent.skill.name",
    "error.type",
    "exception.message",
    "status.code",
    "status.message",
    ...["opencode.", attributePrefix].flatMap((prefix) =>
      ["session.parent_id", "run.id", "interaction.id", "agent.type"].map(
        (key) => `${prefix}${key}`,
      ),
    ),
  ]);
  const reservedPrefixes = [
    "openinference.",
    "gen_ai.",
    "http.request.header.",
    "http.response.header.",
    ...["opencode.", attributePrefix].flatMap((prefix) =>
      ["llm.", "provider.", "message.", "compaction.", "permission.", "tool.", "skill."].map(
        (key) => `${prefix}${key}`,
      ),
    ),
  ];
  const finishedSpanRegistry = createFinishedSpanRegistry();
  const spanOptions = {
    finishedSpanRegistry,
    tracer: options.tracerProvider.getTracer(
      options.instrumentationScope.name,
      options.instrumentationScope.version,
    ),
    rootContext: ROOT_CONTEXT,
    spanNamePrefix: options.spanNamePrefix ?? "opencode.",
    attributePrefix,
    captureContent: options.captureContent ?? false,
    spanAttributes: Object.fromEntries(
      Object.entries(options.spanAttributes ?? {}).filter(
        ([key]) =>
          !reservedAttributes.has(key) &&
          !reservedPrefixes.some((prefix) => key.startsWith(prefix)),
      ),
    ),
  };
  const runSpans = createRunSpans({
    ...spanOptions,
    parentContext: (reference) => toolSpans.context(reference, true),
  });
  const interactionSpans = createInteractionSpans({
    ...spanOptions,
    parentContext: runSpans.context,
  });
  const toolSpans = createToolSpans({ ...spanOptions, parentContext: interactionSpans.context });
  const skillSpans = createSkillSpans({ ...spanOptions, parentContext: interactionSpans.context });
  const permissionSpans = createPermissionSpans({
    ...spanOptions,
    parentContext: (reference) => toolSpans.context(reference) ?? skillSpans.context(reference),
  });
  const compactionSpans = createCompactionSpans({
    ...spanOptions,
    parentContext: interactionSpans.context,
  });
  const llmSpans = createLlmSpans({
    ...spanOptions,
    captureHttpHeaders: options.captureHttpHeaders ?? false,
    spanStartTimes: options.spanStartTimes,
    parentContext: (input) =>
      input.compactionID
        ? compactionSpans.context({ interaction: input.interaction, id: input.compactionID })
        : interactionSpans.context(input.interaction),
  });
  const activeRuns = new Map<
    string,
    { reference: RunReference; parentTool: RunStart["parentTool"] }
  >();
  const state = {
    shutdownPromise: undefined as Promise<void> | undefined,
  };

  function endRun(input: RunFinish, disposing = false) {
    const key = `${input.sessionID}:${input.id}`;

    if (!activeRuns.delete(key)) {
      return;
    }

    activeRuns.forEach((run) => {
      if (run.parentTool && sameRun(run.parentTool.interaction.run, input)) {
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
    const resolveFinishError = (kind: string) =>
      disposing
        ? { type: "_OTHER", message: `plugin disposed before ${kind} completed` }
        : input.error;
    permissionSpans.finishPendingForRun(
      input,
      input.endedAt,
      disposing
        ? { type: "_OTHER", message: "plugin disposed before permission replied" }
        : input.error,
    );
    llmSpans.finishPendingForRun(input, input.endedAt, resolveFinishError("message"));
    compactionSpans.finishPendingForRun(input, input.endedAt, resolveFinishError("compaction"));
    toolSpans.finishPendingForRun(input, input.endedAt, resolveFinishError("tool"));
    skillSpans.finishPendingForRun(input, input.endedAt, resolveFinishError("skill load"));
    interactionSpans.finishPendingForRun(input, input.endedAt, resolveFinishError("interaction"));
    finishedSpanRegistry.markRunClosed(input);
    runSpans.finish(input);
  }

  return {
    startRun(input) {
      if (finishedSpanRegistry.isRunClosed(input) || !runSpans.start(input)) {
        return;
      }

      activeRuns.set(`${input.sessionID}:${input.id}`, {
        reference: { sessionID: input.sessionID, id: input.id },
        parentTool: input.parentTool
          ? {
              callID: input.parentTool.callID,
              messageID: input.parentTool.messageID,
              interaction: {
                id: input.parentTool.interaction.id,
                run: { ...input.parentTool.interaction.run },
              },
            }
          : undefined,
      });
    },
    updateRun: runSpans.update,
    finishRun: endRun,
    finishTool(input) {
      activeRuns.forEach((run) => {
        if (run.parentTool && operationKey(run.parentTool) === operationKey(input)) {
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
      permissionSpans.finishPendingForTool(input, input.endedAt, input.error);
      toolSpans.finish(input);
    },
    startTool: toolSpans.start,
    updateTool: toolSpans.update,
    startSkill: skillSpans.start,
    updateSkill: skillSpans.update,
    finishSkill(input) {
      permissionSpans.finishPendingForTool(input, input.endedAt, input.error);
      skillSpans.finish(input);
    },
    startCompaction: compactionSpans.start,
    finishCompaction(input) {
      llmSpans.finishForCompaction(input.interaction, input.id, input.endedAt, input.error);
      compactionSpans.finish(input);
    },
    startPermission: permissionSpans.start,
    finishPermission: permissionSpans.finish,
    startInteraction: interactionSpans.start,
    finishInteraction: interactionSpans.finish,
    startLlm: llmSpans.start,
    llmTraceHeaders: llmSpans.traceHeaders,
    updateLlm: llmSpans.update,
    finishLlm: llmSpans.finish,
    flush() {
      return state.shutdownPromise ?? options.tracerProvider.forceFlush();
    },
    shutdown() {
      if (state.shutdownPromise) {
        return state.shutdownPromise;
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
      permissionSpans.finishAllOnShutdown(endedAt);
      llmSpans.finishAllOnShutdown(endedAt);
      compactionSpans.finishAllOnShutdown(endedAt);
      toolSpans.finishAllOnShutdown(endedAt);
      skillSpans.finishAllOnShutdown(endedAt);
      interactionSpans.finishAllOnShutdown(endedAt);
      runSpans.finishAllOnShutdown(endedAt);
      state.shutdownPromise = options.tracerProvider.shutdown();
      return state.shutdownPromise;
    },
  };
}
