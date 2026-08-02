import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  command,
  effect,
  event,
  kernel,
  listener,
  project,
  projector,
  query,
  sql,
} from "./mod.ts";
import { sqliteCallCounts } from "./sqlite_instrumentation.ts";

const OrderWasPlaced = event({
  type: "OrderWasPlaced",
  data: z.object({
    customerId: z.number().int(),
  }),
});

const PlaceOrder = command({
  type: "PlaceOrder",
  input: z.object({
    customerId: z.number().int(),
  }),
  handle(context, input) {
    return context.raise(OrderWasPlaced, input);
  },
});

type Environment = Readonly<{
  database: DatabaseSync;
  mailer: Readonly<{
    sendOrderConfirmation(customerId: number): Promise<void>;
  }>;
}>;

const SendOrderConfirmation = effect({
  type: "SendOrderConfirmation",
  input: z.object({
    customerId: z.number().int(),
  }),
  async run(environment: Environment, input) {
    await environment.mailer.sendOrderConfirmation(input.customerId);
  },
});

const SendConfirmationWhenOrderPlaced = listener({
  type: "SendConfirmationWhenOrderPlaced",
  on: OrderWasPlaced,
  handle(context, data) {
    return context.queue(SendOrderConfirmation, data);
  },
});

const Users = projector({
  type: "Users",
  table: "users",
  schema: z.object({
    customerId: z.number().int(),
  }),
  apply: [
    project(
      OrderWasPlaced,
      (data) =>
        sql`INSERT INTO users (customer_id) VALUES (${data.customerId})`,
    ),
  ],
});

const GetUsers = query({
  type: "GetUsers",
  input: z.object({
    limit: z.number().int().positive(),
  }),
  reads: [Users],
  output: z.array(Users.schema),
  run(input) {
    return sql`
      SELECT customer_id AS customerId
      FROM users
      ORDER BY customer_id
      LIMIT ${input.limit}
    `;
  },
});

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");

  database.exec(`
    CREATE TABLE users (
      customer_id INTEGER PRIMARY KEY
    ) STRICT;

    CREATE TABLE other (
      value INTEGER NOT NULL
    ) STRICT;

    INSERT INTO other (value) VALUES (1);
  `);

  return database;
}

function eventCount(database: DatabaseSync): number {
  const row = database.prepare(
    "SELECT count(*) AS count FROM __hyperkernel_events",
  ).get() as { count: number };

  return row.count;
}

function userCount(database: DatabaseSync): number {
  const row = database.prepare(
    "SELECT count(*) AS count FROM users",
  ).get() as { count: number };

  return row.count;
}

function isZodError(error: unknown): boolean {
  return error instanceof Error && error.name === "ZodError";
}

function createApp(
  database: DatabaseSync,
  sent: number[],
  projectors: readonly ReturnType<typeof projector>[] = [Users],
  queries: readonly ReturnType<typeof query>[] = [GetUsers],
) {
  return kernel({
    env: {
      database,
      mailer: {
        async sendOrderConfirmation(customerId: number) {
          await Promise.resolve();
          sent.push(customerId);
        },
      },
    },
    commands: [PlaceOrder],
    events: [OrderWasPlaced],
    listeners: [SendConfirmationWhenOrderPlaced],
    effects: [SendOrderConfirmation],
    projectors,
    queries,
  });
}

export function typeChecks(app: ReturnType<typeof createApp>): void {
  // @ts-expect-error customerId is a number
  app.dispatch(PlaceOrder, { customerId: "42" });

  // @ts-expect-error limit is a number
  app.query(GetUsers, { limit: "10" });
}

export function environmentTypeChecks(database: DatabaseSync): void {
  const NeedsMissingDependency = effect({
    type: "NeedsMissingDependency",
    input: z.object({}),
    run(_environment: { database: DatabaseSync; missing: true }) {},
  });

  kernel({
    env: { database },
    commands: [],
    events: [],
    listeners: [],
    // @ts-expect-error env does not provide the required missing capability
    effects: [NeedsMissingDependency],
    projectors: [],
    queries: [],
  });
}

export function definitionTypeChecks(database: DatabaseSync): void {
  const IncompleteCommand = {
    kind: "command" as const,
    type: "IncompleteCommand",
  };

  kernel({
    env: { database },
    // @ts-expect-error registered commands require input and handle
    commands: [IncompleteCommand],
    events: [],
    listeners: [],
    effects: [],
    projectors: [],
    queries: [],
  });

  const reads = [Users];
  const ReadonlyReads = query({
    type: "ReadonlyReads",
    input: z.object({}),
    reads,
    output: z.array(Users.schema),
    run() {
      return sql`SELECT customer_id AS customerId FROM users`;
    },
  });

  // @ts-expect-error query dependencies are frozen and exposed as readonly
  ReadonlyReads.reads.push(Users);

  command({
    type: "ForgedRaisedEvent",
    input: z.object({}),
    // @ts-expect-error raised events must be created by context.raise
    handle() {
      return {
        kind: "raised-event" as const,
        event: OrderWasPlaced,
        data: { customerId: 42 },
      };
    },
  });

  listener({
    type: "ForgedQueuedEffect",
    on: OrderWasPlaced,
    // @ts-expect-error queued effects must be created by context.queue
    handle() {
      return {
        kind: "queued-effect" as const,
        effect: SendOrderConfirmation,
        input: { customerId: 42 },
      };
    },
  });
}

Deno.test("dispatches one command through event, projection, listener, and async effect", async () => {
  const database = createDatabase();
  const sent: number[] = [];

  try {
    const app = createApp(database, sent);

    await app.dispatch(PlaceOrder, { customerId: 42 });

    assert.deepEqual(app.query(GetUsers, { limit: 10 }), [
      { customerId: 42 },
    ]);
    assert.deepEqual(sent, [42]);
    assert.equal(eventCount(database), 1);
  } finally {
    database.close();
  }
});

Deno.test("rejects invalid command input before changing state", async () => {
  const database = createDatabase();
  const sent: number[] = [];

  try {
    const app = createApp(database, sent);

    await assert.rejects(
      () => app.dispatch(PlaceOrder, { customerId: "invalid" } as never),
      isZodError,
    );
    assert.equal(eventCount(database), 0);
    assert.equal(userCount(database), 0);
    assert.deepEqual(sent, []);
  } finally {
    database.close();
  }
});

Deno.test("factories own their resource discriminator", () => {
  const definition = {
    kind: "not-an-event" as const,
    type: "FactoryOwnedKind",
    data: z.object({}),
  };

  const FactoryOwnedKind = event(definition);

  assert.equal(FactoryOwnedKind.kind, "event");
});

Deno.test("rejects handler results not created by raise or queue", async () => {
  const database = createDatabase();
  const forgedRaised = command({
    type: "ForgedRaised",
    input: z.object({}),
    handle() {
      return {
        kind: "raised-event" as const,
        event: OrderWasPlaced,
        data: { customerId: 42 },
      } as never;
    },
  });
  const forgedQueued = listener({
    type: "ForgedQueued",
    on: OrderWasPlaced,
    handle() {
      return {
        kind: "queued-effect" as const,
        effect: SendOrderConfirmation,
        input: { customerId: 42 },
      } as never;
    },
  });

  try {
    const forgedRaisedApp = kernel({
      env: { database },
      commands: [forgedRaised],
      events: [OrderWasPlaced],
      listeners: [],
      effects: [],
      projectors: [],
      queries: [],
    });

    await assert.rejects(
      () => forgedRaisedApp.dispatch(forgedRaised, {}),
      /Invalid raised-event returned by handler/,
    );
    assert.equal(eventCount(database), 0);

    const forgedQueuedApp = kernel({
      env: {
        database,
        mailer: { async sendOrderConfirmation() {} },
      },
      commands: [PlaceOrder],
      events: [OrderWasPlaced],
      listeners: [forgedQueued],
      effects: [SendOrderConfirmation],
      projectors: [],
      queries: [],
    });

    await assert.rejects(
      () => forgedQueuedApp.dispatch(PlaceOrder, { customerId: 42 }),
      /Invalid queued-effect returned by handler/,
    );
    assert.equal(eventCount(database), 0);
  } finally {
    database.close();
  }
});

Deno.test("parses transformed event and effect values once", async () => {
  const database = createDatabase();
  const transformed: number[] = [];
  const NumberWasReceived = event({
    type: "NumberWasReceived",
    data: z.string().transform(Number),
  });
  const ReceiveNumber = command({
    type: "ReceiveNumber",
    input: z.string(),
    handle(context, input) {
      return context.raise(NumberWasReceived, input);
    },
  });
  const RecordNumber = effect({
    type: "RecordNumber",
    input: z.string().transform(Number),
    run(_environment: Environment, input) {
      transformed.push(input);
    },
  });
  const RecordReceivedNumber = listener({
    type: "RecordReceivedNumber",
    on: NumberWasReceived,
    handle(context, data) {
      return context.queue(RecordNumber, String(data));
    },
  });
  const Numbers = projector({
    type: "Numbers",
    table: "users",
    schema: Users.schema,
    apply: [
      project(
        NumberWasReceived,
        (data) => sql`INSERT INTO users (customer_id) VALUES (${data})`,
      ),
    ],
  });

  try {
    const app = kernel({
      env: {
        database,
        mailer: {
          async sendOrderConfirmation() {},
        },
      },
      commands: [ReceiveNumber],
      events: [NumberWasReceived],
      listeners: [RecordReceivedNumber],
      effects: [RecordNumber],
      projectors: [Numbers],
      queries: [],
    });

    await app.dispatch(ReceiveNumber, "42");

    assert.deepEqual(transformed, [42]);
    assert.equal(userCount(database), 1);
  } finally {
    database.close();
  }
});

Deno.test("rolls back earlier writes when a projector writes outside its table", async () => {
  const database = createDatabase();
  const sent: number[] = [];
  const InvalidOther = projector({
    type: "InvalidOther",
    table: "other",
    schema: z.object({ value: z.number().int() }),
    apply: [
      project(
        OrderWasPlaced,
        (data) => sql`UPDATE users SET customer_id = ${data.customerId}`,
      ),
    ],
  });

  try {
    const app = createApp(database, sent, [Users, InvalidOther], []);

    await assert.rejects(
      () => app.dispatch(PlaceOrder, { customerId: 42 }),
      Error,
    );
    assert.equal(eventCount(database), 0);
    assert.equal(userCount(database), 0);
    assert.deepEqual(sent, []);
    assert.equal(
      (database.prepare("SELECT value FROM other").get() as { value: number })
        .value,
      1,
    );
  } finally {
    database.close();
  }
});

Deno.test("rejects duplicate resource types during registration", () => {
  const database = createDatabase();
  const DuplicatePlaceOrder = command({
    type: "PlaceOrder",
    input: z.object({ customerId: z.number().int() }),
    handle(context, input) {
      return context.raise(OrderWasPlaced, input);
    },
  });

  try {
    assert.throws(
      () =>
        kernel({
          env: { database },
          commands: [PlaceOrder, DuplicatePlaceOrder],
          events: [OrderWasPlaced],
          listeners: [],
          effects: [],
          projectors: [],
          queries: [],
        }),
      /Duplicate command type: PlaceOrder/,
    );
  } finally {
    database.close();
  }
});

Deno.test("validates static definition dependencies during registration", () => {
  const database = createDatabase();
  const UnregisteredOrderWasPlaced = event({
    type: "OrderWasPlaced",
    data: OrderWasPlaced.data,
  });
  const InvalidListener = listener({
    type: "InvalidListener",
    on: UnregisteredOrderWasPlaced,
    handle() {},
  });
  const InvalidProjector = projector({
    type: "InvalidProjector",
    table: "users",
    schema: Users.schema,
    apply: [project(UnregisteredOrderWasPlaced, () => sql`SELECT 1`)],
  });
  const UnregisteredUsers = projector({
    type: "Users",
    table: "users",
    schema: Users.schema,
    apply: [],
  });
  const InvalidQuery = query({
    type: "InvalidQuery",
    input: z.object({}),
    reads: [UnregisteredUsers],
    output: z.array(Users.schema),
    run() {
      return sql`SELECT customer_id AS customerId FROM users`;
    },
  });

  try {
    assert.throws(
      () =>
        kernel({
          env: { database },
          commands: [],
          events: [OrderWasPlaced],
          listeners: [InvalidListener],
          effects: [],
          projectors: [],
          queries: [],
        }),
      /Unregistered event: OrderWasPlaced/,
    );
    assert.throws(
      () =>
        kernel({
          env: { database },
          commands: [],
          events: [OrderWasPlaced],
          listeners: [],
          effects: [],
          projectors: [InvalidProjector],
          queries: [],
        }),
      /Unregistered event: OrderWasPlaced/,
    );
    assert.throws(
      () =>
        kernel({
          env: { database },
          commands: [],
          events: [OrderWasPlaced],
          listeners: [],
          effects: [],
          projectors: [Users],
          queries: [InvalidQuery],
        }),
      /Unregistered projector: Users/,
    );
  } finally {
    database.close();
  }
});

Deno.test("rejects reserved and duplicate projector tables", () => {
  const database = createDatabase();
  const Reserved = projector({
    type: "Reserved",
    table: "__hyperkernel_events",
    schema: z.object({}),
    apply: [],
  });
  const DuplicateUsers = projector({
    type: "DuplicateUsers",
    table: "users",
    schema: Users.schema,
    apply: [],
  });

  try {
    assert.throws(() => createApp(database, [], [Reserved], []), Error);
    assert.throws(
      () => createApp(database, [], [Users, DuplicateUsers], []),
      Error,
    );
  } finally {
    database.close();
  }
});

Deno.test("denies mutations returned by queries", () => {
  const database = createDatabase();
  const sent: number[] = [];
  const MutateUsers = query({
    type: "MutateUsers",
    input: z.object({}),
    reads: [Users],
    output: z.array(Users.schema),
    run() {
      return sql`DELETE FROM users`;
    },
  });

  try {
    const app = createApp(database, sent, [Users], [MutateUsers]);

    assert.throws(() => app.query(MutateUsers, {}), Error);
  } finally {
    database.close();
  }
});

Deno.test("preserves query authorization after the connection authorizer changes", () => {
  const database = createDatabase();
  const sent: number[] = [];
  const MutateUsers = query({
    type: "MutateUsers",
    input: z.object({}),
    reads: [Users],
    output: z.array(Users.schema),
    run() {
      return sql`DELETE FROM users`;
    },
  });

  try {
    const app = createApp(database, sent, [Users], [MutateUsers]);
    const authorizedDatabase = database as DatabaseSync & {
      setAuthorizer(authorizer: null): void;
    };

    authorizedDatabase.setAuthorizer(null);

    assert.throws(() => app.query(MutateUsers, {}), Error);
  } finally {
    database.close();
  }
});

Deno.test("bounds cached statements for input-dependent SQL text", () => {
  const database = createDatabase();
  const sent: number[] = [];
  const DynamicGetUsers = query({
    type: "DynamicGetUsers",
    input: z.object({ limit: z.number().int().positive() }),
    reads: [Users],
    output: z.array(Users.schema),
    run(input) {
      return {
        text:
          `SELECT customer_id AS customerId FROM users LIMIT ${input.limit}`,
        parameters: [],
      };
    },
  });

  try {
    const app = createApp(database, sent, [Users], [DynamicGetUsers]);
    const before = sqliteCallCounts().statementPreparations;

    for (let limit = 1; limit <= 65; limit += 1) {
      app.query(DynamicGetUsers, { limit });
    }

    app.query(DynamicGetUsers, { limit: 1 });

    const after = sqliteCallCounts().statementPreparations;
    assert.equal(after - before, 66);
  } finally {
    database.close();
  }
});

Deno.test("does not reuse an authorized projector statement for a query", async () => {
  const database = createDatabase();
  const sent: number[] = [];
  const InsertUser = query({
    type: "InsertUser",
    input: z.object({ customerId: z.number().int() }),
    reads: [Users],
    output: z.array(Users.schema),
    run(input) {
      return sql`INSERT INTO users (customer_id) VALUES (${input.customerId})`;
    },
  });

  try {
    const app = createApp(database, sent, [Users], [InsertUser]);
    await app.dispatch(PlaceOrder, { customerId: 42 });

    assert.throws(() => app.query(InsertUser, { customerId: 43 }), Error);
    assert.equal(eventCount(database), 1);
    assert.equal(userCount(database), 1);
  } finally {
    database.close();
  }
});

Deno.test("denies queries that read an undeclared projector", () => {
  const database = createDatabase();
  const sent: number[] = [];
  const Other = projector({
    type: "Other",
    table: "other",
    schema: z.object({ value: z.number().int() }),
    apply: [],
  });
  const ReadOther = query({
    type: "ReadOther",
    input: z.object({}),
    reads: [Users],
    output: z.array(Other.schema),
    run() {
      return sql`SELECT value FROM other`;
    },
  });

  try {
    const app = createApp(database, sent, [Users, Other], [ReadOther]);

    assert.throws(() => app.query(ReadOther, {}), Error);
  } finally {
    database.close();
  }
});

Deno.test("validates query output", () => {
  const database = createDatabase();
  const sent: number[] = [];
  const InvalidOutput = query({
    type: "InvalidOutput",
    input: z.object({}),
    reads: [Users],
    output: z.array(Users.schema),
    run() {
      return sql`SELECT customer_id AS wrongName FROM users`;
    },
  });

  try {
    database.prepare("INSERT INTO users (customer_id) VALUES (?)").run(42);
    const app = createApp(database, sent, [Users], [InvalidOutput]);

    assert.throws(() => app.query(InvalidOutput, {}), isZodError);
  } finally {
    database.close();
  }
});
