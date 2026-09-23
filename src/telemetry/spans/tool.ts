import { SpanKind, trace, type Context, type Span } from "@opentelemetry/api";
import type {
  InteractionReference,
  ObservationError,
  RunReference,
  ToolFinish,
  ToolReference,
  ToolStart,
  ToolUpdate,
} from "../../contract/observer.js";
import {
  endSpan,
  agentContextAttributes,
  operationKey,
  sameRun,
  type SpanOptions,
} from "./common.js";

export function createToolSpans(
  options: SpanOptions & {
    parentContext(reference: InteractionReference): Context | undefined;
  },
) {
  const activeSpans = new Map<string, { reference: ToolReference; toolName: string; span: Span }>();

  function finish(input: ToolFinish) {
    const key = operationKey(input);
    const spanState = activeSpans.get(key);

    if (!spanState) {
      return;
    }

    activeSpans.delete(key);
    options.finishedSpanRegistry.add(spanState.reference.interaction.run, "tool", key);

    if (options.captureContent && !input.error && input.output !== undefined) {
      spanState.span.setAttribute("gen_ai.tool.call.result", encodeToolResult(input.output));
    }

    endSpan(spanState.span, input.endedAt, input.error);
  }

  return {
    finish,
    start(input: ToolStart) {
      const key = operationKey(input);
      const parent = options.parentContext(input.interaction);

      if (
        !parent ||
        activeSpans.has(key) ||
        options.finishedSpanRegistry.has(input.interaction.run, "tool", key)
      ) {
        return;
      }

      activeSpans.set(key, {
        reference: {
          interaction: { run: { ...input.interaction.run }, id: input.interaction.id },
          messageID: input.messageID,
          callID: input.callID,
        },
        toolName: input.name,
        span: options.tracer.startSpan(
          `${options.spanNamePrefix}tool.${input.name}`,
          {
            kind: SpanKind.INTERNAL,
            startTime: new Date(input.startedAt),
            attributes: {
              ...options.spanAttributes,
              ...agentContextAttributes(input.interaction.run, input, options.attributePrefix),
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.call.id": input.callID,
              "gen_ai.tool.name": input.name,
              ...(options.captureContent && input.description !== undefined
                ? { "gen_ai.tool.description": input.description }
                : {}),
              ...(options.captureContent && input.arguments !== undefined
                ? { "gen_ai.tool.call.arguments": JSON.stringify(input.arguments) }
                : {}),
            },
          },
          parent,
        ),
      });
    },
    update(input: ToolUpdate) {
      const spanState = activeSpans.get(operationKey(input));

      if (spanState && options.captureContent && input.description !== undefined) {
        spanState.span.setAttribute("gen_ai.tool.description", input.description);
      }

      if (spanState && options.captureContent && input.arguments !== undefined) {
        spanState.span.setAttribute("gen_ai.tool.call.arguments", JSON.stringify(input.arguments));
      }
    },
    context(reference: ToolReference, taskOnly = false) {
      const spanState = activeSpans.get(operationKey(reference));
      return spanState && (!taskOnly || spanState.toolName === "task")
        ? trace.setSpan(options.rootContext, spanState.span)
        : undefined;
    },
    finishPendingForRun(run: RunReference, endedAt: number, error?: ObservationError) {
      activeSpans.forEach((spanState) => {
        if (sameRun(spanState.reference.interaction.run, run)) {
          finish({
            ...spanState.reference,
            endedAt,
            error: error ?? { type: "_OTHER", message: "session ended before tool completed" },
          });
        }
      });
    },
    finishAllOnShutdown(endedAt: number) {
      activeSpans.forEach((spanState) =>
        finish({
          ...spanState.reference,
          endedAt,
          error: { type: "_OTHER", message: "plugin disposed before tool completed" },
        }),
      );
    },
  };
}

function encodeToolResult(output: string) {
  try {
    const value: unknown = JSON.parse(output);

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return JSON.stringify(value);
    }
  } catch {
    // Plain text and non-object JSON use the schema's result object wrapper.
  }

  return JSON.stringify({ content: output });
}
