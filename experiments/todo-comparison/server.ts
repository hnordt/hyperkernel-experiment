import { join } from "node:path";
import { z, ZodError } from "zod";
import { TodoIdSchema, type TodoStore, TodoTitleSchema } from "./contract.ts";
import { createCrudTodoStore } from "./crud_store.ts";
import {
  createHyperkernelTodoStore,
  type HyperkernelTodoStore,
} from "./hyperkernel_store.ts";

const CreateTodoRequestSchema = z.object({
  title: TodoTitleSchema,
}).strict();

const ChangeTodoRequestSchema = z.object({
  completed: z.boolean(),
}).strict();

const EngineSchema = z.enum(["hyperkernel", "crud"]);
const PositionSchema = z.number().int().nonnegative().max(
  Number.MAX_SAFE_INTEGER,
);
const EventPageSizeSchema = z.number().int().positive().max(1_000);
const JsonMediaTypePattern =
  /^application\/(?:json|[!#$%&'*+\-.^_`|~0-9a-z]+\+json)$/;

const todoCollection = new URLPattern({ pathname: "/api/:engine/todos" });
const todoItem = new URLPattern({ pathname: "/api/:engine/todos/:id" });

const securityHeaders = Object.freeze({
  "cache-control": "no-cache",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

const staticFiles = new Map([
  ["/", {
    file: new URL("./public/index.html", import.meta.url),
    type: "text/html; charset=utf-8",
  }],
  [
    "/index.html",
    {
      file: new URL("./public/index.html", import.meta.url),
      type: "text/html; charset=utf-8",
    },
  ],
  [
    "/app.js",
    {
      file: new URL("./public/app.js", import.meta.url),
      type: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/styles.css",
    {
      file: new URL("./public/styles.css", import.meta.url),
      type: "text/css; charset=utf-8",
    },
  ],
]);

export type TodoApiStores = Readonly<{
  hyperkernel: HyperkernelTodoStore;
  crud: TodoStore;
}>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createTodoHandler(
  stores: TodoApiStores,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/api/hyperkernel/events") {
        return eventLogResponse(request, url, stores.hyperkernel);
      }

      const collectionMatch = todoCollection.exec(url);
      if (collectionMatch !== null) {
        const engine = EngineSchema.parse(
          collectionMatch.pathname.groups.engine,
        );
        const store = stores[engine];

        if (request.method === "GET") {
          const at = url.searchParams.get("at");

          if (at !== null && engine !== "hyperkernel") {
            throw new HttpError(
              400,
              "history_not_supported",
              "Only Hyperkernel has historical Todo state",
            );
          }

          const todos = at === null
            ? store.list()
            : stores.hyperkernel.replay(parseInteger(at, PositionSchema));

          return json({ todos });
        }

        if (request.method === "POST") {
          const body = CreateTodoRequestSchema.parse(await readJson(request));
          const todo = await store.create({
            id: crypto.randomUUID(),
            title: body.title,
            createdAt: Date.now(),
          });

          return json({ todo }, { status: 201 });
        }

        return methodNotAllowed("GET, POST");
      }

      const itemMatch = todoItem.exec(url);
      if (itemMatch !== null) {
        const engine = EngineSchema.parse(itemMatch.pathname.groups.engine);
        const store = stores[engine];
        const id = TodoIdSchema.parse(
          decodePathSegment(itemMatch.pathname.groups.id ?? ""),
        );

        if (request.method === "PATCH") {
          const body = ChangeTodoRequestSchema.parse(await readJson(request));
          const changed = await store.setCompleted(id, body.completed);

          if (!changed) {
            throw new HttpError(404, "todo_not_found", "Todo not found");
          }

          return new Response(null, { status: 204, headers: securityHeaders });
        }

        if (request.method === "DELETE") {
          await store.remove(id);
          return new Response(null, { status: 204, headers: securityHeaders });
        }

        return methodNotAllowed("PATCH, DELETE");
      }

      const asset = staticFiles.get(url.pathname);
      if (asset !== undefined) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed("GET, HEAD");
        }

        const body = request.method === "HEAD"
          ? null
          : await Deno.readTextFile(asset.file);
        return new Response(body, {
          headers: { ...securityHeaders, "content-type": asset.type },
        });
      }

      if (url.pathname.startsWith("/api/")) {
        throw new HttpError(404, "route_not_found", "API route not found");
      }

      return new Response("Not found", {
        status: 404,
        headers: {
          ...securityHeaders,
          "content-type": "text/plain; charset=utf-8",
        },
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

function eventLogResponse(
  request: Request,
  url: URL,
  store: HyperkernelTodoStore,
): Response {
  if (request.method !== "GET") return methodNotAllowed("GET");

  const limit = parseOptionalInteger(
    url.searchParams.get("limit"),
    EventPageSizeSchema,
    1_000,
  );
  const stats = store.stats();
  const after = parseOptionalInteger(
    url.searchParams.get("after"),
    PositionSchema,
    Math.max(0, stats.eventCount - limit),
  );
  const events = store.events(after, limit);

  return json({
    events,
    latestPosition: stats.eventCount,
    hasEarlierEvents: (events[0]?.position ?? after + 1) > 1,
    hasLaterEvents: (events.at(-1)?.position ?? after) < stats.eventCount,
  });
}

async function readJson(request: Request): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]
    ?.trim().toLowerCase();

  if (mediaType === undefined || !JsonMediaTypePattern.test(mediaType)) {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Expected application/json or application/*+json",
    );
  }

  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(
      400,
      "invalid_path_encoding",
      "Todo ID contains invalid URL encoding",
    );
  }
}

function parseOptionalInteger<Schema extends z.ZodType<number>>(
  value: string | null,
  schema: Schema,
  fallback: number,
): number {
  return value === null ? fallback : parseInteger(value, schema);
}

function parseInteger<Schema extends z.ZodType<number>>(
  value: string,
  schema: Schema,
): number {
  if (!/^\d+$/.test(value)) {
    throw new HttpError(400, "invalid_number", "Expected a whole number");
  }

  return schema.parse(Number(value));
}

function json(
  value: unknown,
  init: ResponseInit = {},
): Response {
  return Response.json(value, {
    ...init,
    headers: { ...securityHeaders, ...init.headers },
  });
}

function methodNotAllowed(allow: string): Response {
  return json(
    { error: { code: "method_not_allowed", message: "Method not allowed" } },
    { status: 405, headers: { allow } },
  );
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }

  if (error instanceof ZodError) {
    return json(
      {
        error: {
          code: "invalid_request",
          message: "Request data failed validation",
        },
      },
      { status: 400 },
    );
  }

  if (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed: todos.id")
  ) {
    return json(
      { error: { code: "todo_exists", message: "Todo already exists" } },
      { status: 409 },
    );
  }

  console.error(error);
  return json(
    {
      error: {
        code: "internal_error",
        message: "The Todo request could not be completed",
      },
    },
    { status: 500 },
  );
}

type ServerOptions = Readonly<{ port: number; dataDirectory: string }>;

function parseServerOptions(args: readonly string[]): ServerOptions {
  let port = 8_000;
  let dataDirectory = "experiments/todo-comparison/data";

  for (const argument of args) {
    if (argument.startsWith("--port=")) {
      port = z.number().int().min(1).max(65_535).parse(
        Number(argument.slice("--port=".length)),
      );
      continue;
    }

    if (argument.startsWith("--data-dir=")) {
      dataDirectory = argument.slice("--data-dir=".length);
      if (dataDirectory.length === 0) {
        throw new Error("--data-dir cannot be empty");
      }
      continue;
    }

    throw new Error(`Unknown server option: ${argument}`);
  }

  return Object.freeze({ port, dataDirectory });
}

if (import.meta.main) {
  const options = parseServerOptions(Deno.args);
  await Deno.mkdir(options.dataDirectory, { recursive: true });
  const abort = new AbortController();
  const onInterrupt = () => abort.abort();
  let handlesInterrupt = false;
  let hyperkernel: HyperkernelTodoStore | undefined;
  let crud: TodoStore | undefined;

  try {
    hyperkernel = createHyperkernelTodoStore(
      join(options.dataDirectory, "hyperkernel.sqlite"),
    );
    crud = createCrudTodoStore(join(options.dataDirectory, "crud.sqlite"));

    if (Deno.build.os !== "windows") {
      Deno.addSignalListener("SIGINT", onInterrupt);
      handlesInterrupt = true;
    }

    const server = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: options.port,
        signal: abort.signal,
        onListen() {
          console.log(`Todo comparison: http://127.0.0.1:${options.port}`);
        },
      },
      createTodoHandler({ hyperkernel, crud }),
    );
    await server.finished;
  } finally {
    if (handlesInterrupt) {
      Deno.removeSignalListener("SIGINT", onInterrupt);
    }
    crud?.close();
    hyperkernel?.close();
  }
}
