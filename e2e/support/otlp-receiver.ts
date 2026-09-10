type OtlpValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpValue[] };
};

type OtlpAttribute = { key: string; value: OtlpValue };
type OtlpSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttribute[];
  status?: { code?: number; message?: string };
};

type OtlpExport = {
  resourceSpans: Array<{
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans: Array<{
      scope: { name: string; version?: string };
      spans: OtlpSpan[];
    }>;
  }>;
};
export type ExportedSpan = ReturnType<ReturnType<typeof startOtlpReceiver>["spans"]>[number];

function decode(value: OtlpValue): unknown {
  if (value.intValue !== undefined) {
    return Number(value.intValue);
  }

  if (value.arrayValue) {
    return (value.arrayValue.values ?? []).map(decode);
  }

  return value.stringValue ?? value.doubleValue ?? value.boolValue;
}

function attributes(values: OtlpAttribute[] = []): Record<string, unknown> {
  return Object.fromEntries(values.map((attribute) => [attribute.key, decode(attribute.value)]));
}

export function startOtlpReceiver() {
  const payloads: OtlpExport[] = [];
  const headers: Headers[] = [];
  const errors: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/traces") {
        errors.push(`Unexpected OTLP route: ${request.method} ${request.url}`);

        return new Response("Not found", { status: 404 });
      }

      headers.push(new Headers(request.headers));

      try {
        const payload = (await request.json()) as OtlpExport;

        if (!Array.isArray(payload.resourceSpans)) {
          throw new Error("OTLP JSON is missing resourceSpans");
        }

        payloads.push(payload);

        return Response.json({});
      } catch (error) {
        errors.push(String(error));

        return Response.json({}, { status: 400 });
      }
    },
  });

  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    payloads,
    headers,
    errors,
    spans: () =>
      payloads.flatMap((payload) =>
        payload.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((group) =>
            group.spans.map((span) => ({
              ...span,
              attributes: attributes(span.attributes),
              resource: attributes(resource.resource?.attributes),
              scope: group.scope,
              status: span.status ?? {},
            })),
          ),
        ),
      ),
    [Symbol.dispose]: () => server.stop(true),
  };
}
