import { SpanKind, trace, type Context, type Span } from "@opentelemetry/api";
import type {
  InteractionReference,
  ObservationError,
  RunReference,
  SkillFinish,
  SkillMetadata,
  SkillReference,
  SkillStart,
  SkillUpdate,
} from "../../contract/observer.js";
import {
  endSpan,
  agentContextAttributes,
  operationKey,
  sameRun,
  type SpanOptions,
} from "./common.js";

export function createSkillSpans(
  options: SpanOptions & {
    parentContext(reference: InteractionReference): Context | undefined;
  },
) {
  const activeSpans = new Map<string, { reference: SkillReference; span: Span }>();

  function finish(input: SkillFinish) {
    const key = operationKey(input);
    const state = activeSpans.get(key);

    if (!state) {
      return;
    }

    activeSpans.delete(key);
    options.finishedSpanRegistry.add(state.reference.interaction.run, "skill", key);

    if (options.captureContent && !input.error && input.output !== undefined) {
      state.span.setAttribute(`${options.attributePrefix}skill.output`, input.output);
    }

    endSpan(state.span, input.endedAt, input.error);
  }

  return {
    finish,
    start(input: SkillStart) {
      const key = operationKey(input);
      const parent = options.parentContext(input.interaction);

      if (
        !parent ||
        activeSpans.has(key) ||
        options.finishedSpanRegistry.has(input.interaction.run, "skill", key)
      ) {
        return;
      }

      activeSpans.set(key, {
        reference: {
          interaction: { run: { ...input.interaction.run }, id: input.interaction.id },
          messageID: input.messageID,
          callID: input.callID,
        },
        span: options.tracer.startSpan(
          `${options.spanNamePrefix}skill.load`,
          {
            kind: SpanKind.INTERNAL,
            startTime: new Date(input.startedAt),
            attributes: {
              ...options.spanAttributes,
              ...agentContextAttributes(input.interaction.run, input, options.attributePrefix),
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.call.id": input.callID,
              "gen_ai.tool.name": "skill",
              ...skillAttributes(input, options.attributePrefix),
            },
          },
          parent,
        ),
      });
    },
    update(input: SkillUpdate) {
      activeSpans
        .get(operationKey(input))
        ?.span.setAttributes(skillAttributes(input, options.attributePrefix));
    },
    context(reference: SkillReference) {
      const state = activeSpans.get(operationKey(reference));
      return state ? trace.setSpan(options.rootContext, state.span) : undefined;
    },
    finishPendingForRun(run: RunReference, endedAt: number, error?: ObservationError) {
      activeSpans.forEach((state) => {
        if (sameRun(state.reference.interaction.run, run)) {
          finish({
            ...state.reference,
            endedAt,
            error: error ?? {
              type: "_OTHER",
              message: "session ended before skill load completed",
            },
          });
        }
      });
    },
    finishAllOnShutdown(endedAt: number) {
      activeSpans.forEach((state) =>
        finish({
          ...state.reference,
          endedAt,
          error: { type: "_OTHER", message: "plugin disposed before skill load completed" },
        }),
      );
    },
  };
}

function skillAttributes(input: SkillMetadata, attributePrefix: string) {
  return {
    [`${attributePrefix}skill.name`]: input.name,
    "ai.agent.skill.name": input.name,
    [`${attributePrefix}skill.directory`]: input.directory,
    [`${attributePrefix}skill.output.truncated`]: input.outputTruncated,
  };
}
