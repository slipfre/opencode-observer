import { expect, test } from "bun:test";
import { normalizeError } from "../src/adapter/shared/error.js";

test.each([
  { error: undefined, expected: { type: "_OTHER" } },
  { error: null, expected: { type: "_OTHER" } },
  { error: "", expected: { type: "_OTHER" } },
  { error: " \t\n ", expected: { type: "_OTHER" } },
  { error: " connection failed\n", expected: { type: "_OTHER", message: " connection failed\n" } },
  {
    error: new Error("connection failed"),
    expected: { type: "Error", message: "connection failed" },
  },
  { error: new Error("Error"), expected: { type: "Error", message: "Error" } },
  { error: { code: 500 }, expected: { type: "500" } },
  { error: { name: "APIError", message: 500 }, expected: { type: "APIError" } },
  {
    error: { name: "MessageOutputLengthError", data: {} },
    expected: { type: "MessageOutputLengthError" },
  },
  {
    error: Object.assign(new Error("MessageOutputLengthError"), {
      name: "MessageOutputLengthError",
      data: {},
    }),
    expected: { type: "MessageOutputLengthError" },
  },
  {
    error: { name: "APIError", data: { message: " nested details\n" }, message: "outer details" },
    expected: { type: "APIError", message: " nested details\n" },
  },
  {
    error: { name: "APIError", data: {}, message: "outer details" },
    expected: { type: "APIError", message: "outer details" },
  },
  {
    error: { name: "APIError", data: { message: "" }, message: "outer details" },
    expected: { type: "APIError", message: "outer details" },
  },
  {
    error: { name: "APIError", data: { message: " \t " }, message: "outer details" },
    expected: { type: "APIError", message: "outer details" },
  },
  {
    error: { name: "APIError", data: { message: 500 }, message: "outer details" },
    expected: { type: "APIError", message: "outer details" },
  },
  {
    error: { name: "APIError", data: { message: " \t " }, message: " \n " },
    expected: { type: "APIError" },
  },
])("normalizes source error details without inventing a summary: %j", ({ error, expected }) => {
  expect(normalizeError(error)).toEqual(expected);
});
