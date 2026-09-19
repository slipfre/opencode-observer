export type User = { id: string };

export type UserLookupOptions = {
  endpoint: string;
  blackboxAuthHeaderValue?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

export async function lookupUser(
  token: string | undefined,
  options: UserLookupOptions,
): Promise<User | undefined> {
  const normalizedToken = token?.trim();

  if (!normalizedToken) {
    return;
  }

  const maxRetries = options.maxRetries ?? 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const user = await queryUserByToken(normalizedToken, options).catch(() => undefined);

    if (user) {
      return user;
    }

    if (attempt < maxRetries) {
      await Bun.sleep(250 * 2 ** attempt);
    }
  }
}

async function queryUserByToken(token: string, options: UserLookupOptions) {
  const response = await fetch(options.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.blackboxAuthHeaderValue
        ? { "X-Blackbox-Auth": options.blackboxAuthHeaderValue }
        : {}),
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
