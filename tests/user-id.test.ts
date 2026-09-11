import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { getUser, type UserOptions } from "../src/user/index.js";

const options: UserOptions = {
  endpoint: "https://identity.example.test/queryUserByToken",
  retryCount: 0,
};

afterEach(() => mock.restore());

test("posts the trimmed token and returns a normalized user", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ code: 0, result: { ssicNo: " user-1 " } }),
  );

  expect(await getUser(" token ", { ...options, authHeader: "identity-secret" })).toEqual({
    id: "user-1",
  });
  expect(fetcher.mock.calls[0]).toEqual([
    options.endpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", "X-Blackbox-Auth": "identity-secret" },
      body: JSON.stringify({ token: "token" }),
      signal: expect.any(AbortSignal),
    },
  ]);
});

test("does not query without a token and omits an unconfigured authentication header", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ code: 0, result: { ssicNo: "user-1" } }),
  );

  expect(await getUser(undefined, options)).toBeUndefined();
  expect(await getUser("  ", options)).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();

  await getUser("token", options);

  expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ "content-type": "application/json" });
});

test.each([
  null,
  [[]],
  "invalid",
  { code: "0", result: { ssicNo: "user-1" } },
  { code: 1, result: { ssicNo: "user-1" } },
  { code: 0 },
  { code: 0, result: null },
  { code: 0, result: { ssicNo: 42 } },
  { code: 0, result: { ssicNo: "  " } },
  { code: 0, result: { ssicNo: " unknown " } },
])("omits the user for invalid response %j", async (payload) => {
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payload));

  expect(await getUser("token", options)).toBeUndefined();
});

test("waits for HTTP and JSON failure retries before returning the user", async () => {
  const fetcher = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    .mockResolvedValueOnce(new Response("invalid JSON"))
    .mockResolvedValueOnce(Response.json({ code: 0, result: { ssicNo: "user-1" } }));

  expect(await getUser("token", { ...options, retryCount: 2 })).toEqual({ id: "user-1" });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test("retry exhaustion returns no user without rejecting initialization", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unavailable"));

  expect(await getUser("token", { ...options, retryCount: 1 })).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("request timeout aborts the lookup and returns no user", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      { preconnect() {} },
    ),
  );

  const [user] = await Promise.all([
    getUser("token", { ...options, timeoutMs: 20 }),
    Bun.sleep(50),
  ]);

  expect(user).toBeUndefined();
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

test("independent lookups do not share identity state", async () => {
  const first = Promise.withResolvers<Response>();
  spyOn(globalThis, "fetch")
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(Response.json({ code: 0, result: { ssicNo: "user-2" } }));

  const lookup = getUser("token-1", options);

  expect(await getUser("token-2", options)).toEqual({ id: "user-2" });

  first.resolve(Response.json({ code: 0, result: { ssicNo: "user-1" } }));

  expect(await lookup).toEqual({ id: "user-1" });
});
