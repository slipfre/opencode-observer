import { expect } from "bun:test";
import type { E2EFixture, RunResult } from "./fixture.js";
import type { ExportedSpan } from "./otlp-receiver.js";

export function oneSpan(spans: ExportedSpan[], name: string) {
  const matches = spans.filter((span) => span.name === name);
  expect(matches).toHaveLength(1);

  return matches[0]!;
}

export function expectUnset(span: ExportedSpan) {
  expect(span.status.code ?? 0).toBe(0);
  expect(span.attributes["error.type"]).toBeUndefined();
}

export function expectError(span: ExportedSpan, type: string) {
  expect(span.status.code).toBe(2);
  expect(span.attributes["error.type"]).toBe(type);
  expect(span.status.message).toBeString();
  expect(span.status.message!.length).toBeGreaterThan(0);
}

export function messages(span: ExportedSpan, direction: "input" | "output") {
  const value = span.attributes[`gen_ai.${direction}.messages`];
  expect(value).toBeString();

  return JSON.parse(String(value)) as unknown;
}

export function requireSpans(fixture: E2EFixture, result: RunResult, count: number, exitCode = 0) {
  if (result.exitCode !== exitCode) {
    throw new Error(
      `Expected exit ${exitCode}, received ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  expect(fixture.llm.errors).toEqual([]);
  expect(fixture.llm.pending()).toBe(0);
  expect(fixture.otlp.errors).toEqual([]);
  const spans = fixture.otlp.spans();

  // The CLI has exited: all spans must have been flushed, with no delayed exports or duplicates.
  if (spans.length !== count) {
    throw new Error(
      `Expected ${count} spans, received ${spans.length}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  expect(new Set(spans.map((span) => span.spanId)).size).toBe(count);
  spans.forEach((span) => {
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
    expect(span.attributes["session.id"]).toBeString();
    expect(span.attributes["gen_ai.conversation.id"]).toBe(span.attributes["session.id"]);
  });
  fixture.llm.hits.forEach((hit) => {
    expect(hit.headers.has("x-opencode-observer-request")).toBe(false);
  });

  return spans;
}
