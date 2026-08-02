import assert from "node:assert/strict";
import { join } from "node:path";
import {
  type AuditedCrudTodoStore,
  createAuditedCrudTodoStore,
} from "./audited_crud_store.ts";
import type { TodoStore } from "./contract.ts";
import { createCrudTodoStore } from "./crud_store.ts";
import { CREATE_EVENT_LOG_SQL, openTodoDatabase } from "./database.ts";
import {
  createTodoEventLogReader,
  TODO_COMPLETION_CHANGED,
  TODO_CREATED,
  TODO_DELETED,
} from "./event_log.ts";
import {
  createHyperkernelTodoStore,
  type HyperkernelTodoStore,
} from "./hyperkernel_store.ts";

type StoreFactory = (path: string) => TodoStore;

const stores: readonly Readonly<{
  name: string;
  audited: boolean;
  create: StoreFactory;
}>[] = [
  { name: "traditional CRUD", audited: false, create: createCrudTodoStore },
  { name: "audited CRUD", audited: true, create: createAuditedCrudTodoStore },
  { name: "Hyperkernel", audited: true, create: createHyperkernelTodoStore },
];

for (const definition of stores) {
  Deno.test(`${definition.name} implements the Todo store contract in WAL mode`, async () => {
    await withStore(definition.create, async (store) => {
      assert.deepEqual(
        await store.create({ id: "later", title: "  Later  ", createdAt: 200 }),
        { id: "later", title: "Later", completed: false, createdAt: 200 },
      );
      await store.create({ id: "first", title: "First", createdAt: 100 });

      assert.deepEqual(store.list(), [
        { id: "first", title: "First", completed: false, createdAt: 100 },
        { id: "later", title: "Later", completed: false, createdAt: 200 },
      ]);
      assert.deepEqual(store.get("first"), {
        id: "first",
        title: "First",
        completed: false,
        createdAt: 100,
      });
      assert.equal(store.get("missing"), null);

      assert.equal(await store.setCompleted("first", true), true);
      assert.equal(await store.setCompleted("first", true), true);
      assert.equal(await store.setCompleted("missing", true), false);
      assert.equal(store.get("first")?.completed, true);

      assert.equal(await store.remove("later"), true);
      assert.equal(await store.remove("later"), false);
      assert.deepEqual(store.list().map((todo) => todo.id), ["first"]);

      const stats = store.stats();
      assert.equal(stats.journalMode, "wal");
      assert.equal(stats.todoCount, 1);
      assert.equal(stats.eventCount, definition.audited ? 4 : 0);
      assert.ok(stats.pageCount > 0);
      assert.ok(stats.pageSize > 0);
      assert.ok(stats.freelistCount >= 0);
    });
  });

  Deno.test(`${definition.name} validates writes and rolls duplicate creation back`, async () => {
    await withStore(definition.create, async (store) => {
      for (
        const invalid of [
          { id: "invalid", title: "   ", createdAt: 1 },
          { id: "invalid", title: "\0not-sqlite-text", createdAt: 1 },
          { id: "invalid\0id", title: "Valid title", createdAt: 1 },
          { id: "invalid", title: "\uD800", createdAt: 1 },
          { id: "invalid\uD800", title: "Valid title", createdAt: 1 },
        ]
      ) {
        await assert.rejects(
          () => store.create(invalid),
          (error: unknown) =>
            error instanceof Error && error.name === "ZodError",
        );
      }
      const emptyStats = store.stats();
      assert.equal(emptyStats.todoCount, 0);
      assert.equal(emptyStats.eventCount, 0);

      const input = { id: "duplicate", title: "One", createdAt: 1 } as const;
      await store.create(input);
      await assert.rejects(() => store.create(input), Error);

      assert.equal(store.stats().todoCount, 1);
      assert.equal(store.stats().eventCount, definition.audited ? 1 : 0);
    });
  });

  Deno.test(`${definition.name} uses SQLite BINARY ordering for tied timestamps`, async () => {
    await withStore(definition.create, async (store) => {
      for (const id of ["a", "B", "\u{10000}", "\uE000"]) {
        await store.create({ id, title: id, createdAt: 1 });
      }

      assert.deepEqual(store.list().map((todo) => todo.id), [
        "B",
        "a",
        "\uE000",
        "\u{10000}",
      ]);
    });
  });
}

Deno.test("Hyperkernel exposes a validated event log and historical snapshots", async () => {
  await withTimelineStore(createHyperkernelTodoStore, async (store) => {
    await store.create({ id: "one", title: "One", createdAt: 1 });
    await store.setCompleted("one", true);
    await store.create({ id: "two", title: "Two", createdAt: 2 });
    await store.remove("one");

    assert.deepEqual(
      store.events().map(({ position, type }) => ({ position, type })),
      [
        { position: 1, type: TODO_CREATED },
        { position: 2, type: TODO_COMPLETION_CHANGED },
        { position: 3, type: TODO_CREATED },
        { position: 4, type: TODO_DELETED },
      ],
    );
    assert.deepEqual(store.events(1, 2).map((event) => event.position), [2, 3]);
    assert.deepEqual(store.replay(0), []);
    assert.deepEqual(store.replay(1), [
      { id: "one", title: "One", completed: false, createdAt: 1 },
    ]);
    assert.deepEqual(store.replay(2), [
      { id: "one", title: "One", completed: true, createdAt: 1 },
    ]);
    assert.deepEqual(store.replay(3), [
      { id: "one", title: "One", completed: true, createdAt: 1 },
      { id: "two", title: "Two", completed: false, createdAt: 2 },
    ]);
    assert.deepEqual(store.replay(4), store.list());
  });
});

Deno.test("Hyperkernel replay preserves the live SQLite BINARY order", async () => {
  await withTimelineStore(createHyperkernelTodoStore, async (store) => {
    for (const id of ["a", "B", "\u{10000}", "\uE000"]) {
      await store.create({ id, title: id, createdAt: 1 });
    }

    const liveIds = store.list().map((todo) => todo.id);
    assert.deepEqual(liveIds, ["B", "a", "\uE000", "\u{10000}"]);
    assert.deepEqual(store.replay().map((todo) => todo.id), liveIds);
  });
});

Deno.test("audited CRUD is an event-write control with the same history", async () => {
  await withTwoTimelineStores(async (hyperkernel, auditedCrud) => {
    for (const store of [hyperkernel, auditedCrud]) {
      await store.create({ id: "one", title: "One", createdAt: 1 });
      await store.setCompleted("one", true);
      await store.remove("one");
    }

    assert.deepEqual(auditedCrud.events(), hyperkernel.events());
    assert.deepEqual(auditedCrud.replay(), hyperkernel.replay());
    assert.deepEqual(auditedCrud.stats().eventCount, 3);
  });
});

Deno.test("event log reader rejects malformed stored JSON", async () => {
  const directory = await makeTestDirectory();
  let database: ReturnType<typeof openTodoDatabase> | undefined;

  try {
    database = openTodoDatabase(join(directory, "malformed.sqlite"));
    const activeDatabase = database;
    activeDatabase.exec(CREATE_EVENT_LOG_SQL);
    activeDatabase.prepare(
      "INSERT INTO __hyperkernel_events (type, data) VALUES (?, ?)",
    ).run(TODO_CREATED, "not json");

    assert.throws(
      () => createTodoEventLogReader(activeDatabase).events(),
      SyntaxError,
    );
  } finally {
    database?.close();
    await Deno.remove(directory, { recursive: true });
  }
});

async function withStore(
  factory: StoreFactory,
  run: (store: TodoStore) => Promise<void>,
): Promise<void> {
  const directory = await makeTestDirectory();
  let store: TodoStore | undefined;

  try {
    store = factory(join(directory, "todos.sqlite"));
    await run(store);
  } finally {
    store?.close();
    await Deno.remove(directory, { recursive: true });
  }
}

async function withTimelineStore<Store extends TodoStore>(
  factory: (path: string) => Store,
  run: (store: Store) => Promise<void>,
): Promise<void> {
  const directory = await makeTestDirectory();
  let store: Store | undefined;

  try {
    store = factory(join(directory, "todos.sqlite"));
    await run(store);
  } finally {
    store?.close();
    await Deno.remove(directory, { recursive: true });
  }
}

async function withTwoTimelineStores(
  run: (
    hyperkernel: HyperkernelTodoStore,
    auditedCrud: AuditedCrudTodoStore,
  ) => Promise<void>,
): Promise<void> {
  const directory = await makeTestDirectory();
  let hyperkernel: HyperkernelTodoStore | undefined;
  let auditedCrud: AuditedCrudTodoStore | undefined;

  try {
    hyperkernel = createHyperkernelTodoStore(
      join(directory, "hyperkernel.sqlite"),
    );
    auditedCrud = createAuditedCrudTodoStore(
      join(directory, "audited-crud.sqlite"),
    );
    await run(hyperkernel, auditedCrud);
  } finally {
    auditedCrud?.close();
    hyperkernel?.close();
    await Deno.remove(directory, { recursive: true });
  }
}

function makeTestDirectory(): Promise<string> {
  return Deno.makeTempDir({
    dir: import.meta.dirname,
    prefix: ".todo-test-",
  });
}
