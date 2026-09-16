import { SpanKind, trace, type Context, type Span } from "@opentelemetry/api";
import type {
  CompactionFinish,
  CompactionReference,
  CompactionStart,
  InteractionReference,
  ObservationError,
  RunReference,
} from "../../contract/observer.js";
import { endSpan, identityAttributes, operationKey, sameRun, type SpanOptions } from "./common.js";

export function createCompactionSpans(
  options: SpanOptions & {
    parentContext(reference: InteractionReference): Context | undefined;
  },
) {
  const compactions = new Map<string, { reference: CompactionReference; span: Span }>();
  const finished = new Set<string>();
  const contexts = new Map<string, { run: RunReference; context: Context }>();

  function finish(input: CompactionFinish) {
    const key = operationKey(input);
    const compaction = compactions.get(key);

    if (!compaction) {
      return;
    }

    compactions.delete(key);
    finished.add(key);
    contexts.set(key, {
      run: compaction.reference.interaction.run,
      context: trace.setSpanContext(options.rootContext, compaction.span.spanContext()),
    });

    if (!input.error) {
      compaction.span.setAttributes({
        "opencode.compaction.prompt_tokens": input.promptTokens,
        "opencode.compaction.summary_tokens": input.summaryTokens,
        "gen_ai.usage.input_tokens": input.usage?.inputTokens,
        "gen_ai.usage.output_tokens": input.usage?.outputTokens,
        "gen_ai.usage.reasoning.output_tokens": input.usage?.reasoningTokens,
        "gen_ai.usage.cache_read.input_tokens": input.usage?.cacheReadTokens,
        "gen_ai.usage.cache_write.input_tokens": input.usage?.cacheWriteTokens,
      });
    }

    endSpan(compaction.span, input.endedAt, input.error);
  }

  return {
    finish,
    start(input: CompactionStart) {
      const key = operationKey(input);
      const parent = options.parentContext(input.interaction);

      if (!parent || compactions.has(key) || finished.has(key)) {
        return;
      }

      compactions.set(key, {
        reference: {
          interaction: { run: { ...input.interaction.run }, id: input.interaction.id },
          id: input.id,
        },
        span: options.tracer.startSpan(
          `${options.tracePrefix}compaction`,
          {
            kind: SpanKind.INTERNAL,
            startTime: new Date(input.startedAt),
            attributes: {
              ...options.spanAttributes,
              ...identityAttributes(input.interaction.run, input),
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
      const compaction = compactions.get(key);
      return compaction
        ? trace.setSpan(options.rootContext, compaction.span)
        : contexts.get(key)?.context;
    },
    closeRun(run: RunReference, endedAt: number, error?: ObservationError) {
      compactions.forEach((compaction) => {
        if (sameRun(compaction.reference.interaction.run, run)) {
          finish({
            ...compaction.reference,
            endedAt,
            error: error ?? {
              type: "_OTHER",
              message: "session ended before compaction completed",
            },
          });
        }
      });
      contexts.forEach((value, key) => {
        if (sameRun(value.run, run)) {
          contexts.delete(key);
        }
      });
    },
    close(endedAt: number) {
      compactions.forEach((compaction) =>
        finish({
          ...compaction.reference,
          endedAt,
          error: { type: "_OTHER", message: "plugin disposed before compaction completed" },
        }),
      );
    },
  };
}
