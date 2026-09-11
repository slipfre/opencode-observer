export type User = { id: string };

export type UserOptions = {
  endpoint: string;
  authHeader?: string;
  timeoutMs?: number;
  retryCount?: number;
};

export async function getUser(
  apiKey: string | undefined,
  options: UserOptions,
): Promise<User | undefined> {
  const token = apiKey?.trim();

  if (!token) {
    return;
  }

  const retryCount = options.retryCount ?? 2;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    const user = await queryUserByToken(token, options).catch(() => undefined);

    if (user) {
      return user;
    }

    if (attempt < retryCount) {
      await Bun.sleep(250 * 2 ** attempt);
    }
  }
}

async function queryUserByToken(token: string, options: UserOptions) {
  const response = await fetch(options.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.authHeader ? { "X-Blackbox-Auth": options.authHeader } : {}),
    },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
  });

  if (!response.ok) {
    await response.body?.cancel();

    return;
  }

  const payload: unknown = await response.json();

  if (!payload || typeof payload !== "object" || !("code" in payload) || payload.code !== 0) {
    return;
  }

  const result = "result" in payload ? payload.result : undefined;

  if (!result || typeof result !== "object" || !("ssicNo" in result)) {
    return;
  }

  const userID = typeof result.ssicNo === "string" ? result.ssicNo.trim() : undefined;

  return userID && userID !== "unknown" ? { id: userID } : undefined;
}
