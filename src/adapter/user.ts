import { getUser } from "../user/index.js";

export async function getOpenCodeUser(env: Record<string, string | undefined> = process.env) {
  if (["false", "0"].includes(env.OPENCODE_USER_ID_ENABLED?.trim().toLowerCase() ?? "")) {
    return;
  }

  const endpoint = env.OPENCODE_USER_ID_ENDPOINT?.trim();

  if (!endpoint || !URL.canParse(endpoint)) {
    return;
  }

  if (!["http:", "https:"].includes(new URL(endpoint).protocol)) {
    return;
  }

  return getUser(env.OPENCODE_USER_ID_TOKEN, {
    endpoint,
    authHeader: env["OPENCODE_USER_ID_X-Blackbox-Auth"],
    timeoutMs: readInteger(env.OPENCODE_USER_ID_TIMEOUT, 3000, 1),
    retryCount: readInteger(env.OPENCODE_USER_ID_RETRY_COUNT, 2, 0, 10),
  });
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
