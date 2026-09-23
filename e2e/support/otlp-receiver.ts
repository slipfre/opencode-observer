import { Server, ServerCredentials, type ServerUnaryCall, type sendUnaryData } from "@grpc/grpc-js";
import { decodeProtobuf } from "./otlp-protobuf.js";

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

export type OtlpExport = {
  resourceSpans: Array<{
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans: Array<{
      scope: { name: string; version?: string };
      spans: OtlpSpan[];
    }>;
  }>;
};
export type ExportedSpan = ReturnType<
  Awaited<ReturnType<typeof startOtlpReceiver>>["spans"]
>[number];

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

export async function startOtlpReceiver(delayMs = 0, protocol = "http/json") {
  const payloads: OtlpExport[] = [];
  const headers: Headers[] = [];
  const errors: string[] = [];
  const state = { pending: 0 };
  const receive = async (payload: OtlpExport, requestHeaders: Headers) => {
    if (!Array.isArray(payload.resourceSpans)) {
      throw new Error("OTLP request is missing resourceSpans");
    }

    headers.push(requestHeaders);
    payloads.push(payload);
    if (delayMs > 0) {
      state.pending++;
      await Bun.sleep(delayMs);
      state.pending--;
    }
  };
  const server =
    protocol === "grpc"
      ? await startGrpcReceiver(receive, errors)
      : Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/traces") {
              errors.push(`Unexpected OTLP route: ${request.method} ${request.url}`);
              return new Response("Not found", { status: 404 });
            }

            try {
              const contentType =
                protocol === "http/protobuf" ? "application/x-protobuf" : "application/json";
              if (request.headers.get("content-type") !== contentType) {
                throw new Error(
                  `Expected ${contentType}, received ${request.headers.get("content-type")}`,
                );
              }

              await receive(
                protocol === "http/protobuf"
                  ? decodeProtobuf(new Uint8Array(await request.arrayBuffer()))
                  : ((await request.json()) as OtlpExport),
                new Headers(request.headers),
              );
              return protocol === "http/protobuf"
                ? new Response(new Uint8Array(), { headers: { "Content-Type": contentType } })
                : Response.json({});
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
    pending: () => state.pending,
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

async function startGrpcReceiver(
  receive: (payload: OtlpExport, headers: Headers) => Promise<void>,
  errors: string[],
) {
  const server = new Server();
  server.addService(
    {
      export: {
        path: "/opentelemetry.proto.collector.trace.v1.TraceService/Export",
        requestStream: false,
        responseStream: false,
        requestSerialize: () => {
          throw new Error("Receiver only decodes requests");
        },
        requestDeserialize: decodeProtobuf,
        responseSerialize: () => Buffer.alloc(0),
        responseDeserialize: () => ({}),
      },
    },
    {
      export(call: ServerUnaryCall<OtlpExport, object>, callback: sendUnaryData<object>) {
        receive(
          call.request,
          new Headers(
            Object.entries(call.metadata.getMap()).map(([key, value]) => [key, value.toString()]),
          ),
        )
          .then(() => callback(null, {}))
          .catch((error: unknown) => {
            errors.push(String(error));
            callback(error instanceof Error ? error : new Error(String(error)));
          });
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(port);
    });
  });
  return { port, stop: () => server.forceShutdown() };
}
