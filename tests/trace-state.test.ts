import { expect, test } from "bun:test";
import { userTraceState } from "../src/adapter/model/trace-state.js";

test("user tracestate preserves vendor order and replaces only its own entry", () => {
  expect(userTraceState(undefined, " user-1 ")).toBe("user_id=user-1");
  expect(
    userTraceState(
      "vendor=one, user_id=old,other=two,user_id=duplicate,user_id_extra=kept",
      "new-user",
    ),
  ).toBe("user_id=new-user,vendor=one,other=two,user_id_extra=kept");
  expect(userTraceState("vendor=one", "user.name@example.test")).toBe(
    "user_id=user.name@example.test,vendor=one",
  );
  expect(userTraceState("vendor=one", "x".repeat(256))).toBe(
    `user_id=${"x".repeat(256)},vendor=one`,
  );
});

test.each([
  undefined,
  "",
  " \t ",
  "unknown",
  "a=b",
  "a,b",
  "a\nb",
  "a\rb",
  "a\tb",
  "\u007f",
  "用户",
  "x".repeat(257),
])("missing or unrepresentable user ID falls back to unknown: %j", (id) => {
  expect(userTraceState("vendor=one", id)).toBe("user_id=unknown,vendor=one");
});

test("user tracestate retains 32 whole entries and evicts only the last vendor", () => {
  const vendors = Array.from({ length: 32 }, (_, index) => `vendor${index}=value${index}`);
  const result = userTraceState(vendors.join(","), "user-1");

  expect(result.split(",")).toEqual(["user_id=user-1", ...vendors.slice(0, 31)]);
  expect(userTraceState(result, "user-2").split(",")).toEqual([
    "user_id=user-2",
    ...vendors.slice(0, 31),
  ]);
});
