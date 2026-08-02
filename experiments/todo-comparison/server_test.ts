import assert from "node:assert/strict";
import { join } from "node:path";
import { createCrudTodoStore } from "./crud_store.ts";
import { createHyperkernelTodoStore } from "./hyperkernel_store.ts";
import { createTodoHandler } from "./server.ts";

Deno.test("Todo HTTP API drives both stores and exposes Hyperkernel history", async () => {
  await withHandler(async (request) => {
    const initial = await request("/api/hyperkernel/todos");
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { todos: [] });

    const unsupported = await request("/api/hyperkernel/todos", {
      method: "POST",
      body: JSON.stringify({ title: "Missing content type" }),
    });
    assert.equal(unsupported.status, 415);

    const created = await request("/api/hyperkernel/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Ship the experiment" }),
    });
    assert.equal(created.status, 201);
    const createPayload = await created.json() as {
      todo: { id: string; completed: boolean };
    };
    assert.match(createPayload.todo.id, /^[0-9a-f-]{36}$/);
    assert.equal(createPayload.todo.completed, false);

    const id = createPayload.todo.id;
    const completed = await request(
      `/api/hyperkernel/todos/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ completed: true }),
      },
    );
    assert.equal(completed.status, 204);

    const eventsAfterCompletion = await request("/api/hyperkernel/events");
    assert.equal(eventsAfterCompletion.status, 200);
    const eventPayload = await eventsAfterCompletion.json() as {
      latestPosition: number;
      events: readonly { position: number; type: string }[];
    };
    assert.equal(eventPayload.latestPosition, 2);
    assert.deepEqual(eventPayload.events.map((event) => event.type), [
      "TodoCreated",
      "TodoCompletionChanged",
    ]);

    const afterCreation = await request("/api/hyperkernel/todos?at=1");
    const afterCreationPayload = await afterCreation.json() as {
      todos: readonly { completed: boolean }[];
    };
    assert.equal(afterCreationPayload.todos[0]?.completed, false);

    const afterCompletion = await request("/api/hyperkernel/todos?at=2");
    const afterCompletionPayload = await afterCompletion.json() as {
      todos: readonly { completed: boolean }[];
    };
    assert.equal(afterCompletionPayload.todos[0]?.completed, true);

    const removed = await request(
      `/api/hyperkernel/todos/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    assert.equal(removed.status, 204);

    const latestEventPage = await (
      await request("/api/hyperkernel/events?limit=1")
    ).json() as {
      latestPosition: number;
      hasEarlierEvents: boolean;
      hasLaterEvents: boolean;
      events: readonly { position: number; type: string }[];
    };
    assert.equal(latestEventPage.latestPosition, 3);
    assert.deepEqual(latestEventPage.events, [{
      position: 3,
      type: "TodoDeleted",
      data: { id },
    }]);
    assert.equal(latestEventPage.hasEarlierEvents, true);
    assert.equal(latestEventPage.hasLaterEvents, false);

    const firstEventPage = await (
      await request("/api/hyperkernel/events?after=0&limit=1")
    ).json() as {
      hasEarlierEvents: boolean;
      hasLaterEvents: boolean;
      events: readonly { position: number }[];
    };
    assert.deepEqual(
      firstEventPage.events.map((event) => event.position),
      [1],
    );
    assert.equal(firstEventPage.hasEarlierEvents, false);
    assert.equal(firstEventPage.hasLaterEvents, true);

    assert.deepEqual(
      await (await request("/api/hyperkernel/todos")).json(),
      { todos: [] },
    );
    assert.deepEqual(
      await (await request("/api/hyperkernel/todos?at=0")).json(),
      { todos: [] },
    );

    const crudCreated = await request("/api/crud/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Direct write" }),
    });
    assert.equal(crudCreated.status, 201);
    const crudTodos = await (await request("/api/crud/todos")).json() as {
      todos: readonly { title: string }[];
    };
    assert.deepEqual(crudTodos.todos.map((todo) => todo.title), [
      "Direct write",
    ]);

    const crudHistory = await request("/api/crud/todos?at=0");
    assert.equal(crudHistory.status, 400);
    assert.equal(
      (await crudHistory.json() as { error: { code: string } }).error.code,
      "history_not_supported",
    );
  });
});

Deno.test("Todo handler serves an exact static allowlist and predictable errors", async () => {
  await withHandler(async (request) => {
    const page = await request("/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /default-src 'self'/,
    );
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /object-src 'none'/,
    );
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(await page.text(), /<todo-comparison>/);

    for (
      const [path, contentType] of [
        ["/index.html", /^text\/html/],
        ["/app.js", /^text\/javascript/],
        ["/styles.css", /^text\/css/],
      ] as const
    ) {
      const asset = await request(path);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type") ?? "", contentType);
      assert.ok((await asset.text()).length > 0);
    }

    const scriptHead = await request("/app.js", { method: "HEAD" });
    assert.equal(scriptHead.status, 200);
    assert.equal(await scriptHead.text(), "");

    for (const path of ["/server.ts", "/public/app.js", "/app.js/"]) {
      assert.equal((await request(path)).status, 404);
    }

    const staticMutation = await request("/app.js", { method: "POST" });
    assert.equal(staticMutation.status, 405);
    assert.equal(staticMutation.headers.get("allow"), "GET, HEAD");

    const unknownApi = await request("/api/unknown");
    assert.equal(unknownApi.status, 404);
    assert.equal(
      (await unknownApi.json() as { error: { code: string } }).error.code,
      "route_not_found",
    );

    const invalidJson = await request("/api/crud/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(invalidJson.status, 400);

    const falseJsonMediaType = await request("/api/crud/todos", {
      method: "POST",
      headers: { "content-type": "application/jsonp" },
      body: JSON.stringify({ title: "Must not be created" }),
    });
    assert.equal(falseJsonMediaType.status, 415);

    const malformedStructuredSuffix = await request("/api/crud/todos", {
      method: "POST",
      headers: { "content-type": "garbage+json" },
      body: JSON.stringify({ title: "Must not be created" }),
    });
    assert.equal(malformedStructuredSuffix.status, 415);

    const structuredJson = await request("/api/crud/todos", {
      method: "POST",
      headers: { "content-type": "application/problem+json" },
      body: JSON.stringify({ title: "Structured JSON" }),
    });
    assert.equal(structuredJson.status, 201);
    const structuredJsonTodo = await structuredJson.json() as {
      todo: { id: string };
    };
    assert.equal(
      (
        await request(
          `/api/crud/todos/${encodeURIComponent(structuredJsonTodo.todo.id)}`,
          { method: "DELETE" },
        )
      ).status,
      204,
    );

    const nulTitle = await request("/api/crud/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "\0not SQLite text" }),
    });
    assert.equal(nulTitle.status, 400);

    for (const engine of ["crud", "hyperkernel"]) {
      const illFormedTitle = await request(`/api/${engine}/todos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "\uD800" }),
      });
      assert.equal(illFormedTitle.status, 400);
    }

    const malformedId = await request("/api/crud/todos/%", {
      method: "DELETE",
    });
    assert.equal(malformedId.status, 400);
    assert.equal(
      (await malformedId.json() as { error: { code: string } }).error.code,
      "invalid_path_encoding",
    );

    const notAllowed = await request("/api/crud/todos", { method: "PUT" });
    assert.equal(notAllowed.status, 405);
    assert.equal(notAllowed.headers.get("allow"), "GET, POST");
  });
});

Deno.test("event log defaults to the latest page beyond 1,000 events", async () => {
  await withHandler(async (request) => {
    for (let index = 0; index < 1_001; index += 1) {
      const response = await request("/api/hyperkernel/todos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: `Todo ${index}` }),
      });
      assert.equal(response.status, 201);
    }

    const latest = await (
      await request("/api/hyperkernel/events")
    ).json() as {
      latestPosition: number;
      hasEarlierEvents: boolean;
      hasLaterEvents: boolean;
      events: readonly { position: number }[];
    };
    assert.equal(latest.latestPosition, 1_001);
    assert.equal(latest.events.length, 1_000);
    assert.equal(latest.events[0]?.position, 2);
    assert.equal(latest.events.at(-1)?.position, 1_001);
    assert.equal(latest.hasEarlierEvents, true);
    assert.equal(latest.hasLaterEvents, false);

    const oldest = await (
      await request("/api/hyperkernel/events?after=0&limit=1")
    ).json() as {
      hasEarlierEvents: boolean;
      hasLaterEvents: boolean;
      events: readonly { position: number }[];
    };
    assert.deepEqual(oldest.events.map((event) => event.position), [1]);
    assert.equal(oldest.hasEarlierEvents, false);
    assert.equal(oldest.hasLaterEvents, true);
  });
});

type RequestOptions = Readonly<{
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
}>;

async function withHandler(
  run: (
    request: (path: string, options?: RequestOptions) => Promise<Response>,
  ) => Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({
    dir: import.meta.dirname,
    prefix: ".server-test-",
  });
  let hyperkernel: ReturnType<typeof createHyperkernelTodoStore> | undefined;
  let crud: ReturnType<typeof createCrudTodoStore> | undefined;

  try {
    hyperkernel = createHyperkernelTodoStore(
      join(directory, "hyperkernel.sqlite"),
    );
    crud = createCrudTodoStore(join(directory, "crud.sqlite"));
    const handler = createTodoHandler({ hyperkernel, crud });
    await run((path, options = {}) =>
      handler(new Request(new URL(path, "http://todo.test"), options))
    );
  } finally {
    crud?.close();
    hyperkernel?.close();
    await Deno.remove(directory, { recursive: true });
  }
}
