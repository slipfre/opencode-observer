import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createFetchModelCapture, type FetchEndReason } from "../src/adapter/model/fetch.js";

const captures: ReturnType<typeof createFetchModelCapture>[] = [];
const traceparent = "00-11111111111111111111111111111111-2222222222222222-01";
afterEach(() => {
  captures.splice(0).forEach((capture) => capture.close());
  mock.restore();
});

function setup(response: Response | (() => Promise<Response>)) {
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(typeof response === "function" ? response : async () => response, {
      preconnect: globalThis.fetch.preconnect,
    }),
  );
  const original = globalThis.fetch;
  const clock = { now: 1000, active: true };
  const starts: number[] = [];
  const ends: Array<{ time: number; reason: FetchEndReason }> = [];
  const errors: unknown[] = [];
  const capture = createFetchModelCapture({
    log: (error) => errors.push(error),
    now: () => clock.now,
  });
  captures.push(capture);
  capture.bind(traceparent, {
    active: () => clock.active,
    start(time) {
      starts.push(time);
      return (time, reason) => ends.push({ time, reason });
    },
  });
  return { capture, transport, original, clock, starts, ends, errors };
}

test("unrelated and inactive requests retain the original response and transport arguments", async () => {
  const original = new Response("unrelated");
  const h = setup(original);
  const options = { method: "POST", headers: { authorization: "keep" }, body: "request" };
  expect(await fetch("https://model.test", options)).toBe(original);
  h.clock.active = false;
  expect(await fetch("https://model.test", { headers: { traceparent } })).toBe(original);
  expect(h.transport.mock.calls[0]).toEqual(["https://model.test", options]);
  expect(original.bodyUsed).toBe(false);
  expect(h.starts).toEqual([]);
  expect(h.ends).toEqual([]);
});

test("fetch resolves at headers and EOF records the end without changing bytes or response metadata", async () => {
  const chunks = [new Uint8Array([0, 255, 1]), new Uint8Array([2, 128, 3])];
  const pending = [...chunks];
  const source = new Response(
    new ReadableStream(
      {
        pull(controller) {
          const next = pending.shift();
          if (next) {
            controller.enqueue(next);
            return;
          }
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    { status: 201, statusText: "Created", headers: { "x-kept": "yes" } },
  );
  Object.defineProperties(source, {
    url: { value: "https://model.test/final" },
    redirected: { value: true },
  });
  const h = setup(source);
  const request = new Request("https://model.test", { headers: { Traceparent: traceparent } });
  const response = await fetch(request);
  expect(h.starts).toEqual([1000]);
  expect(h.ends).toEqual([]);
  expect(pending).toHaveLength(2);
  expect(response.status).toBe(201);
  expect(response.statusText).toBe("Created");
  expect(response.url).toBe(source.url);
  expect(response.redirected).toBe(true);
  expect(response.type).toBe(source.type);
  expect(response.headers.get("x-kept")).toBe("yes");
  expect(h.transport).toHaveBeenCalledWith(request);

  h.clock.now = 1200;
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    new Uint8Array([0, 255, 1, 2, 128, 3]),
  );
  expect(h.ends).toEqual([{ time: 1200, reason: "eof" }]);
  expect(h.errors).toEqual([]);
});

test("init headers override Request headers and cannot associate an unrelated request", async () => {
  const source = new Response("ok");
  const h = setup(source);
  expect(
    await fetch(new Request("https://model.test", { headers: { traceparent } }), { headers: {} }),
  ).toBe(source);
  expect(h.starts).toEqual([]);
});

test("empty and HTTP error responses preserve status and report transport completion", async () => {
  const h = setup(new Response(null, { status: 204 }));
  const response = await fetch("https://model.test", { headers: { traceparent } });
  expect(response.status).toBe(204);
  expect(h.ends).toEqual([{ time: 1000, reason: "empty" }]);

  h.transport.mockImplementation(
    Object.assign(async () => new Response("bad request", { status: 400 }), {
      preconnect: h.original.preconnect,
    }),
  );
  const error = await fetch("https://model.test", { headers: { traceparent } });
  expect(error.status).toBe(400);
  expect(await error.text()).toBe("bad request");
  expect(h.ends.at(-1)?.reason).toBe("eof");
});

test.each([true, false])(
  "fetch exceptions preserve identity, including synchronous throws=%s",
  async (sync) => {
    const failure = new TypeError("transport failed");
    const h = setup(() => {
      if (sync) {
        throw failure;
      }
      return Promise.reject(failure);
    });
    await expect(fetch("https://model.test", { headers: { traceparent } })).rejects.toBe(failure);
    expect(h.ends).toEqual([{ time: 1000, reason: "error" }]);
  },
);

test("stream errors are passed to the SDK with exactly one terminal observation", async () => {
  const failure = new Error("stream interrupted");
  const h = setup(
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(failure);
        },
      }),
    ),
  );
  const response = await fetch("https://model.test", { headers: { traceparent } });
  h.clock.now = 1100;
  await expect(response.text()).rejects.toBe(failure);
  expect(h.ends).toEqual([{ time: 1100, reason: "error" }]);
});

test("cancel propagates its reason to the original stream and closes only once", async () => {
  const cancel = mock(() => {});
  const h = setup(new Response(new ReadableStream({ cancel })));
  const response = await fetch("https://model.test", { headers: { traceparent } });
  h.clock.now = 1300;
  await response.body!.cancel("consumer stopped");
  expect(cancel).toHaveBeenCalledWith("consumer stopped");
  expect(h.ends).toEqual([{ time: 1300, reason: "cancel" }]);
});

test("a locked original body is returned unchanged and remains an incomplete measurement", async () => {
  const source = new Response("locked");
  const reader = source.body!.getReader();
  const h = setup(source);
  expect(await fetch("https://model.test", { headers: { traceparent } })).toBe(source);
  expect(h.ends).toEqual([]);
  reader.releaseLock();
});

test("observer failures do not change successful transport or stream output", async () => {
  const h = setup(new Response("ok"));
  h.capture.bind(traceparent, {
    active: () => true,
    start() {
      throw new Error("observer failed");
    },
  });
  expect(await (await fetch("https://model.test", { headers: { traceparent } })).text()).toBe("ok");
  expect(h.errors).toHaveLength(1);
});

test("observers share a wrapper, dispose independently, and ignore in-flight completion after close", async () => {
  const h = setup(new Response("ok"));
  const wrapped = globalThis.fetch;
  const second = createFetchModelCapture({ log: () => {} });
  captures.push(second);
  expect(globalThis.fetch).toBe(wrapped);
  const response = await fetch("https://model.test", { headers: { traceparent } });
  h.capture.close();
  expect(globalThis.fetch).toBe(wrapped);
  expect(await response.text()).toBe("ok");
  expect(h.ends).toEqual([]);
  second.close();
  expect(globalThis.fetch).toBe(h.original);
});

test("disposal leaves a later third-party fetch wrapper intact", () => {
  const h = setup(new Response("ok"));
  const other = new Proxy(globalThis.fetch, {});
  globalThis.fetch = other;
  h.capture.close();
  expect(globalThis.fetch).toBe(other);
  globalThis.fetch = h.original;
});
