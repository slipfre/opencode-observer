import { Socket } from "node:net";

type ProbeResult = { ok: boolean; ms: number; error?: string };

/** Checks TCP reachability only; no TLS handshake or OTLP request is sent. */
export function probeEndpoint(endpoint: string, signal?: AbortSignal): Promise<ProbeResult> {
  const url = URL.parse(endpoint);
  if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname) {
    return Promise.resolve({ ok: false, ms: 0, error: "Invalid OTLP endpoint URL" });
  }

  return new Promise((resolve) => {
    const started = performance.now();
    const socket = new Socket();
    const finish = (result: Omit<ProbeResult, "ms">) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolve({ ...result, ms: performance.now() - started });
    };
    const abort = () => finish({ ok: false, error: "TCP probe cancelled" });
    // Bound DNS lookup and connection establishment together, not just socket inactivity.
    const timeout = setTimeout(
      () => finish({ ok: false, error: "TCP probe timed out after 5000 ms" }),
      5000,
    );
    timeout.unref();
    socket.once("connect", () => finish({ ok: true }));
    socket.once("error", (error) => finish({ ok: false, error: error.message }));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }

    try {
      socket.connect({
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      });
      socket.unref();
    } catch (error) {
      finish({
        ok: false,
        error: error instanceof Error ? error.message : "TCP connection failed",
      });
    }
  });
}
