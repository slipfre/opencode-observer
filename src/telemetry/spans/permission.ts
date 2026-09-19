import { SpanKind, type Context, type Span } from "@opentelemetry/api";
import type {
  ObservationError,
  PermissionFinish,
  PermissionReference,
  PermissionStart,
  RunReference,
  ToolReference,
} from "../../contract/observer.js";
import {
  endSpan,
  agentContextAttributes,
  operationKey,
  sameRun,
  type SpanOptions,
} from "./common.js";

export function createPermissionSpans(
  options: SpanOptions & {
    parentContext(reference: ToolReference): Context | undefined;
  },
) {
  const activeSpans = new Map<string, { reference: PermissionReference; span: Span }>();

  function finish(input: PermissionFinish) {
    const key = `${operationKey(input.tool)}:${input.requestID}`;
    const spanState = activeSpans.get(key);

    if (!spanState) {
      return;
    }

    activeSpans.delete(key);
    options.finishedSpanRegistry.add(spanState.reference.tool.interaction.run, "permission", key);

    if (input.reply !== undefined) {
      spanState.span.setAttributes({
        "opencode.permission.reply": input.reply,
        "opencode.permission.granted": input.reply !== "reject",
      });
    }

    endSpan(spanState.span, input.endedAt, input.error);
  }

  return {
    finish,
    start(input: PermissionStart) {
      const key = `${operationKey(input.tool)}:${input.requestID}`;
      const parent = options.parentContext(input.tool);

      if (
        !parent ||
        activeSpans.has(key) ||
        options.finishedSpanRegistry.has(input.tool.interaction.run, "permission", key)
      ) {
        return;
      }

      activeSpans.set(key, {
        reference: {
          requestID: input.requestID,
          tool: {
            callID: input.tool.callID,
            messageID: input.tool.messageID,
            interaction: { run: { ...input.tool.interaction.run }, id: input.tool.interaction.id },
          },
        },
        span: options.tracer.startSpan(
          `${options.spanNamePrefix}permission.check`,
          {
            kind: SpanKind.INTERNAL,
            startTime: new Date(input.startedAt),
            attributes: {
              ...options.spanAttributes,
              ...agentContextAttributes(input.tool.interaction.run, input),
              "gen_ai.tool.call.id": input.tool.callID,
              "gen_ai.tool.name": input.toolName,
              "opencode.permission.name": input.name,
              "opencode.permission.patterns": [...input.patterns],
            },
          },
          parent,
        ),
      });
    },
    finishPendingForTool(tool: ToolReference, endedAt: number, error?: ObservationError) {
      activeSpans.forEach((spanState) => {
        if (operationKey(spanState.reference.tool) === operationKey(tool)) {
          finish({
            ...spanState.reference,
            endedAt,
            error: error ?? { type: "_OTHER", message: "tool ended before permission replied" },
          });
        }
      });
    },
    finishPendingForRun(run: RunReference, endedAt: number, error?: ObservationError) {
      activeSpans.forEach((spanState) => {
        if (sameRun(spanState.reference.tool.interaction.run, run)) {
          finish({
            ...spanState.reference,
            endedAt,
            error: error ?? { type: "_OTHER", message: "session ended before permission replied" },
          });
        }
      });
    },
    finishAllOnShutdown(endedAt: number) {
      activeSpans.forEach((spanState) =>
        finish({
          ...spanState.reference,
          endedAt,
          error: { type: "_OTHER", message: "plugin disposed before permission replied" },
        }),
      );
    },
  };
}
