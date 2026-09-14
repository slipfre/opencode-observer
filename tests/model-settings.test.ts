import { expect, test } from "bun:test";
import { jsonSchema, Output, tool } from "ai";
import { parseModelSettings } from "../src/adapter/model/settings.js";
import { parseModelHeaders } from "../src/adapter/model/headers.js";

test("model settings capture active tool definitions and explicit output formats", async () => {
  const schema = { type: "object" as const, properties: { path: { type: "string" as const } } };
  const event = {
    output: Output.json(),
    tools: {
      read: tool({ description: "Read a file", inputSchema: jsonSchema(schema) }),
      inactive: tool({ inputSchema: jsonSchema({ type: "object" }) }),
      search: tool({
        type: "provider",
        id: "vendor.search",
        args: {},
        inputSchema: jsonSchema({}),
      }),
    },
    activeTools: ["read", "search"],
  };
  const errors: unknown[] = [];
  const result = await parseModelSettings(event, true, (error) => errors.push(error));

  expect(result).toEqual({
    outputType: "json",
    toolDefinitions: [
      { type: "function", name: "read", description: "Read a file", parameters: schema },
      { type: "vendor.search", name: "search" },
    ],
  });
  expect(errors).toEqual([]);
  expect(
    await parseModelSettings({ ...event, activeTools: [], output: Output.text() }, true, () => {}),
  ).toEqual({ outputType: "text", toolDefinitions: [] });
  expect(
    await parseModelSettings(
      { output: undefined, tools: undefined, activeTools: undefined },
      true,
      () => {},
    ),
  ).toEqual({ outputType: undefined, toolDefinitions: undefined });
});

test("disabled capture observes only output type without reading tools or schemas", async () => {
  const unreadable = () => {
    throw new Error("content must not be read");
  };
  const event = {
    output: Output.object({ schema: jsonSchema({ type: "object" }) }),
    get tools() {
      return unreadable();
    },
    get activeTools() {
      return unreadable();
    },
  };

  expect(await parseModelSettings(event, false, unreadable)).toEqual({
    outputType: "json",
    toolDefinitions: undefined,
  });
});

test("a failed tool schema preserves its identity and other definitions", async () => {
  const failure = new Error("schema unavailable");
  const errors: unknown[] = [];
  const result = await parseModelSettings(
    {
      output: undefined,
      activeTools: undefined,
      tools: {
        broken: tool({ inputSchema: jsonSchema(() => Promise.reject(failure)) }),
        working: tool({ inputSchema: jsonSchema(Promise.resolve({ type: "object" })) }),
      },
    },
    true,
    (error) => errors.push(error),
  );

  expect(result.toolDefinitions).toEqual([
    { type: "function", name: "broken", parameters: undefined },
    { type: "function", name: "working", parameters: { type: "object" } },
  ]);
  expect(errors).toEqual([failure]);
});

test("model headers preserve values and arrays without leaking the internal marker", () => {
  const headers = {
    "X-Test": "one,two",
    "x-test": ["three", "four"],
    "Set-Cookie": ["first=1", "second=2"],
    "X-OpenCode-Observer-Request": "internal",
    absent: undefined,
    invalid: ["valid", 1],
    ...JSON.parse('{"__proto__":"ordinary header"}'),
  };
  const result = parseModelHeaders(headers);
  headers["Set-Cookie"].push("later=3");

  expect(result).toEqual({
    "x-test": ["one,two", "three", "four"],
    "set-cookie": ["first=1", "second=2"],
    ...JSON.parse('{"__proto__":["ordinary header"]}'),
  });
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(parseModelHeaders(undefined)).toBeUndefined();
  expect(parseModelHeaders({})).toEqual({});
});
