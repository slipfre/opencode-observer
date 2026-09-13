import { lookupUser, type User } from "./lookup.js";

// Undefined means lookup was skipped; null means it failed after all attempts.
export async function resolveUser(
  env: Record<string, string | undefined> = process.env,
): Promise<User | null | undefined> {
  if (!isUserIDEnabled(env)) {
    return;
  }

  const endpoint = env.OPENCODE_USER_ID_ENDPOINT?.trim();
  const token = env.OPENCODE_USER_ID_TOKEN?.trim();

  if (!token || !endpoint || !URL.canParse(endpoint)) {
    return;
  }

  if (!["http:", "https:"].includes(new URL(endpoint).protocol)) {
    return;
  }

  return (
    (await lookupUser(token, {
      endpoint,
      authHeader: env["OPENCODE_USER_ID_X-Blackbox-Auth"],
      timeoutMs: readInteger(env.OPENCODE_USER_ID_TIMEOUT, 3000, 1),
      retryCount: readInteger(env.OPENCODE_USER_ID_RETRY_COUNT, 2, 0, 10),
    })) ?? null
  );
}

export function isUserIDEnabled(env: Record<string, string | undefined> = process.env) {
  return !["false", "0"].includes(env.OPENCODE_USER_ID_ENABLED?.trim().toLowerCase() ?? "");
}

function readInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (value === undefined || !/^\d+$/.test(value)) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
