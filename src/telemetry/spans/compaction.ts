import { SpanKind, trace, type Context, type Span } from "@opentelemetry/api";
import type {
  CompactionFinish,
  CompactionReference,
  CompactionStart,
  InteractionReference,
  ObservationError,
  RunReference,
} from "../../contract/observer.js";
import {
  endSpan,
  agentContextAttributes,
  operationKey,
  sameRun,
  type SpanOptions,
} from "./common.js";

export function createCompactionSpans(
  options: SpanOptions & {
    parentContext(reference: InteractionReference): Context | undefined;
  },
) {
  const activeSpans = new Map<string, { reference: CompactionReference; span: Span }>();

  function finish(input: CompactionFinish) {
    const key = operationKey(input);
    const spanState = activeSpans.get(key);

    if (!spanState) {
      return;
    }

    activeSpans.delete(key);
    options.finishedSpanRegistry.add(
      spanState.reference.interaction.run,
      "compaction",
      key,
      trace.setSpanContext(options.rootContext, spanState.span.spanContext()),
    );

    if (!input.error) {
      spanState.span.setAttributes({
        "opencode.compaction.prompt_tokens": input.promptTokens,
        "opencode.compaction.summary_tokens": input.summaryTokens,
      });
    }

    endSpan(spanState.span, input.endedAt, input.error);
  }

  return {
    finish,
    start(input: CompactionStart) {
      const key = operationKey(input);
      const parent = options.parentContext(input.interaction);

      if (
        !parent ||
        activeSpans.has(key) ||
        options.finishedSpanRegistry.has(input.interaction.run, "compaction", key)
      ) {
        return;
      }

      activeSpans.set(key, {
        reference: {
          interaction: { run: { ...input.interaction.run }, id: input.interaction.id },
          id: input.id,
        },
        span: options.tracer.startSpan(
          `${options.spanNamePrefix}compaction`,
          {
            kind: SpanKind.INTERNAL,
            startTime: new Date(input.startedAt),
            attributes: {
              ...options.spanAttributes,
              ...agentContextAttributes(input.interaction.run, input),
              "opencode.compaction.id": input.id,
              "opencode.compaction.auto": input.auto,
              "opencode.compaction.overflow": input.overflow,
              "opencode.compaction.trigger_message.id": input.triggerMessageID,
            },
          },
          parent,
        ),
      });
    },
    context(reference: CompactionReference) {
      const key = operationKey(reference);
      const spanState = activeSpans.get(key);
      return spanState
        ? trace.setSpan(options.rootContext, spanState.span)
        : options.finishedSpanRegistry.context(reference.interaction.run, "compaction", key);
    },
    finishPendingForRun(run: RunReference, endedAt: number, error?: ObservationError) {
      activeSpans.forEach((spanState) => {
        if (sameRun(spanState.reference.interaction.run, run)) {
          finish({
            ...spanState.reference,
            endedAt,
            error: error ?? {
              type: "_OTHER",
              message: "session ended before compaction completed",
            },
          });
        }
      });
    },
    finishAllOnShutdown(endedAt: number) {
      activeSpans.forEach((spanState) =>
        finish({
          ...spanState.reference,
          endedAt,
          error: { type: "_OTHER", message: "plugin disposed before compaction completed" },
        }),
      );
    },
  };
}
