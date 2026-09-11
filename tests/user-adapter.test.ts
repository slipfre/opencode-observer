import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { getOpenCodeUser } from "../src/adapter/user.js";

const env = {
  OPENCODE_USER_ID_ENDPOINT: "https://identity.example.test/queryUserByToken",
  OPENCODE_USER_ID_TOKEN: "token",
  OPENCODE_USER_ID_RETRY_COUNT: "0",
};

afterEach(() => mock.restore());

test("adapter passes identity parameters and waits for the lookup result", async () => {
  const response = Promise.withResolvers<Response>();
  const fetcher = spyOn(globalThis, "fetch").mockReturnValue(response.promise);
  const completed = mock();
  const lookup = getOpenCodeUser({
    ...env,
    OPENCODE_USER_ID_ENDPOINT: " https://identity.example.test/queryUserByToken ",
    OPENCODE_USER_ID_TOKEN: " token ",
    "OPENCODE_USER_ID_X-Blackbox-Auth": "identity-secret",
    OPENCODE_USER_ID_TIMEOUT: "100",
  }).then((user) => {
    completed();

    return user;
  });
  await Bun.sleep(0);

  expect(completed).not.toHaveBeenCalled();

  response.resolve(Response.json({ code: 0, result: { ssicNo: " user-1 " } }));

  expect(await lookup).toEqual({ id: "user-1" });
  expect(completed).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual([
    env.OPENCODE_USER_ID_ENDPOINT,
    {
      method: "POST",
      headers: { "content-type": "application/json", "X-Blackbox-Auth": "identity-secret" },
      body: JSON.stringify({ token: "token" }),
      signal: expect.any(AbortSignal),
    },
  ]);
});

test("adapter waits for configured retries before returning identity", async () => {
  const fetcher = spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce(Response.json({ code: 0, result: { ssicNo: "user-1" } }));

  expect(await getOpenCodeUser({ ...env, OPENCODE_USER_ID_RETRY_COUNT: "1" })).toEqual({
    id: "user-1",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test.each([
  { OPENCODE_USER_ID_ENABLED: "false" },
  { OPENCODE_USER_ID_ENABLED: "0" },
  { OPENCODE_USER_ID_TOKEN: " " },
  { OPENCODE_USER_ID_ENDPOINT: undefined },
  { OPENCODE_USER_ID_ENDPOINT: "queryUserByToken" },
  { OPENCODE_USER_ID_ENDPOINT: "file:///tmp/identity" },
])(
  "disabled or incomplete adapter identity configuration makes no requests: %j",
  async (options) => {
    const fetcher = spyOn(globalThis, "fetch");

    expect(await getOpenCodeUser({ ...env, ...options })).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  },
);

test.each(["0", "-1", "1.5", "invalid", "9007199254740992"])(
  "adapter replaces invalid timeout %s with the default",
  async (value) => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ code: 0, result: { ssicNo: "user-1" } }),
    );
    const timeout = spyOn(AbortSignal, "timeout");

    expect(await getOpenCodeUser({ ...env, OPENCODE_USER_ID_TIMEOUT: value })).toEqual({
      id: "user-1",
    });
    expect(timeout).toHaveBeenCalledWith(3000);
  },
);
