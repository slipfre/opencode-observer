import { expect, test } from "bun:test";
import type { OnStepFinishEvent } from "ai";
import { parseModelInput, parseModelOutput } from "../src/adapter/model/messages.js";

test("model input preserves system messages, history and tool arguments/results", () => {
  const result = parseModelInput({
    messages: [
      { role: "system", content: "History instructions" },
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "consider" },
          { type: "text", text: "checking" },
          { type: "tool-call", toolCallId: "call1", toolName: "read", input: '{"path":"a.ts"}' },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "read",
            output: { type: "json", value: { lines: [1, 2] } },
          },
        ],
      },
      { role: "user", content: "continue" },
    ],
  });

  expect(result.messages[0]).toEqual({
    role: "system",
    parts: [{ type: "text", text: "History instructions" }],
  });
  expect(result.messages.map((message) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "tool",
    "user",
  ]);
  expect(result.messages[2]?.parts).toEqual([
    { type: "reasoning", text: "consider" },
    { type: "text", text: "checking" },
    { type: "tool-call", id: "call1", name: "read", arguments: { path: "a.ts" } },
  ]);
  expect(result.messages[3]?.parts).toEqual([
    { type: "tool-result", id: "call1", response: { lines: [1, 2] } },
  ]);
});

test("model input does not read separate system or provider instructions", () => {
  const event = {
    messages: [{ role: "system" as const, content: "history" }],
    get system() {
      throw new Error("must not read separate system instructions");
    },
    get providerOptions() {
      throw new Error("must not read provider instructions");
    },
  };

  expect(parseModelInput(event)).toEqual({
    messages: [{ role: "system", parts: [{ type: "text", text: "history" }] }],
  });
  event.messages.length = 0;
  expect(parseModelInput(event)).toEqual({ messages: [] });
});

test("model media snapshots copy bytes and preserve URI and MIME information", () => {
  const data = new Uint8Array([1, 2, 3]);
  const result = parseModelInput({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: data, mediaType: "image/png" },
          { type: "image", image: new URL("https://example.test/image.png") },
          { type: "file", data: "data:application/pdf;base64,AQID", mediaType: "application/pdf" },
          { type: "file", data: "data:audio/wav,%01%02%03", mediaType: "audio/wav" },
        ],
      },
    ],
  });
  data.fill(9);

  expect(result.messages[0]?.parts).toEqual([
    { type: "text", text: "look" },
    {
      type: "media",
      modality: "image",
      mimeType: "image/png",
      source: { type: "base64", data: "AQID" },
    },
    {
      type: "media",
      modality: "image",
      mimeType: undefined,
      source: { type: "uri", uri: "https://example.test/image.png" },
    },
    {
      type: "media",
      modality: "document",
      mimeType: "application/pdf",
      source: { type: "base64", data: "AQID" },
    },
    {
      type: "media",
      modality: "audio",
      mimeType: "audio/wav",
      source: { type: "base64", data: "AQID" },
    },
  ]);
});

test("model output uses the current generated candidate and excludes history and tool execution results", () => {
  const event = {
    content: [
      { type: "reasoning", text: "plan" },
      { type: "text", text: "" },
      { type: "tool-call", toolCallId: "call2", toolName: "read", input: { path: "file" } },
      {
        type: "tool-result",
        toolCallId: "call2",
        toolName: "read",
        output: "client execution result",
      },
      { type: "file", file: { mediaType: "image/png", uint8Array: new Uint8Array([1, 2, 3]) } },
    ],
    response: { messages: [{ role: "assistant", content: "previous candidate" }] },
  } as unknown as OnStepFinishEvent;

  expect(parseModelOutput(event)).toEqual([
    {
      role: "assistant",
      parts: [
        { type: "reasoning", text: "plan" },
        { type: "text", text: "" },
        { type: "tool-call", id: "call2", name: "read", arguments: { path: "file" } },
        {
          type: "media",
          modality: "image",
          mimeType: "image/png",
          source: { type: "base64", data: "AQID" },
        },
      ],
    },
  ]);
  expect(parseModelOutput({ ...event, content: [] })).toEqual([]);
  expect(
    parseModelOutput({ ...event, content: [{ type: "unknown" }] } as unknown as OnStepFinishEvent),
  ).toBeUndefined();
});

test("tool payload conversion snapshots shared JSON, preserves null and tolerates malformed arguments", () => {
  const shared = { x: 1 };
  const result = parseModelInput({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "a",
            toolName: "read",
            input: { first: shared, second: shared },
          },
          { type: "tool-call", toolCallId: "b", toolName: "read", input: "{incomplete" },
          { type: "tool-call", toolCallId: "c", toolName: "read", input: null },
        ],
      },
    ],
  });
  shared.x = 2;

  expect(result.messages[0]?.parts).toEqual([
    { type: "tool-call", id: "a", name: "read", arguments: { first: { x: 1 }, second: { x: 1 } } },
    { type: "tool-call", id: "b", name: "read", arguments: "{incomplete" },
    { type: "tool-call", id: "c", name: "read", arguments: null },
  ]);
});
