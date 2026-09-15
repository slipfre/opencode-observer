import { expect, mock, test } from "bun:test";
import { createGuard } from "../src/adapter/shared/guard.js";

test("guard processes source events immediately and does not wait for diagnostics", async () => {
  const failure = new Error("observation failed");
  const logging = Promise.withResolvers<void>();
  const events: string[] = [];
  const log = mock(() => {
    events.push("log");
    return logging.promise;
  });
  const guard = createGuard(log);

  const result = guard(() => {
    events.push("observe");
    throw failure;
  });

  expect(events).toEqual(["observe", "log"]);
  await expect(result).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith(failure);

  logging.reject(new Error("logging failed later"));
  await Bun.sleep(0);

  expect(log).toHaveBeenCalledTimes(1);
});

test.each(["throw", "reject"])(
  "guard contains asynchronous failure even when logging %s",
  async (mode) => {
    const failure = new Error("export failed");
    const log = mock(() => {
      if (mode === "throw") {
        throw new Error("logging failed");
      }

      return Promise.reject(new Error("logging failed"));
    });
    const guard = createGuard(log);

    await expect(guard(() => Promise.reject(failure))).resolves.toBeUndefined();
    await Bun.sleep(0);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(failure);
  },
);
