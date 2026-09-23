import { hrTimeDuration, millisToHrTime } from "@opentelemetry/core";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

/** Keep propagated span IDs while applying late-observed starts to immutable export views. */
export function createTimingProcessor(
  next: SpanProcessor,
  starts: WeakMap<object, number>,
): SpanProcessor {
  return {
    onStart: (span, context) => next.onStart(span, context),
    onEnd(span) {
      const time = starts.get(span);
      starts.delete(span);
      if (time === undefined) {
        next.onEnd(span);
        return;
      }

      const startTime = millisToHrTime(time);
      const duration = hrTimeDuration(startTime, span.endTime);
      next.onEnd(
        new Proxy(span, {
          get(target, key) {
            if (key === "startTime") {
              return startTime;
            }
            if (key === "duration") {
              return duration;
            }
            if (key === "spanContext") {
              return () => target.spanContext();
            }
            return Reflect.get(target, key, target);
          },
        }),
      );
    },
    forceFlush: () => next.forceFlush(),
    shutdown: () => next.shutdown(),
  };
}
