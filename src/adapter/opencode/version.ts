import type { PluginInput } from "@opencode-ai/plugin";

export async function getOpenCodeVersion(client: PluginInput["client"]) {
  const controller = new AbortController();
  const deadline = Promise.withResolvers<undefined>();
  const timeout = setTimeout(() => {
    deadline.resolve(undefined);
    controller.abort();
  }, 1000);

  // The legacy plugin SDK has no health method. Reuse its transport to preserve
  // authentication and the in-process fetch used when the CLI has no HTTP listener.
  const response = await Promise.race([
    deadline.promise,
    Promise.resolve().then(() =>
      client["_client"].get({
        url: "/global/health",
        signal: controller.signal,
        responseStyle: "fields",
        throwOnError: false,
      }),
    ),
  ]).finally(() => clearTimeout(timeout));

  if (
    !response?.data ||
    typeof response.data !== "object" ||
    !("version" in response.data) ||
    typeof response.data.version !== "string"
  ) {
    return undefined;
  }

  return response.data.version.trim() || undefined;
}
