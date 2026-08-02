import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  command,
  effect,
  event,
  kernel,
  listener,
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
  apply(project) {
    return [
      project(
        OrderWasPlaced,
        (data) =>
          sql`INSERT INTO users (customer_id) VALUES (${data.customerId})`,
      ),
    ];
  },
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
  projectors: Parameters<typeof kernel>[0]["projectors"] = [Users],
  queries: Parameters<typeof kernel>[0]["queries"] = [GetUsers],
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

  const handmadeCommandValue = {
    kind: "command",
    type: "HandmadeCommand",
    input: z.object({}),
  } as const;
  // @ts-expect-error command descriptors must come from command()
  const handmadeCommand: Parameters<typeof app.dispatch>[0] =
    handmadeCommandValue;

  const handmadeQueryValue = {
    kind: "query",
    type: "HandmadeQuery",
    input: z.object({}),
    output: z.array(z.object({})),
  } as const;
  // @ts-expect-error query descriptors must come from query()
  const handmadeQuery: Parameters<typeof app.query>[0] = handmadeQueryValue;

  const RawCommandResult = command({
    type: "RawCommandResult",
    input: z.object({ customerId: z.number().int() }),
    handle(context, input) {
      const raw = {
        kind: "raised-event" as const,
        event: OrderWasPlaced,
        data: input,
      };

      // @ts-expect-error command results must come from context.raise()
      const result: ReturnType<typeof context.raise> = raw;
      return result;
    },
  });
  const RawListenerResult = listener({
    type: "RawListenerResult",
    on: OrderWasPlaced,
    handle(context, data) {
      const raw = {
        kind: "queued-effect" as const,
        effect: SendOrderConfirmation,
        input: data,
      };

      // @ts-expect-error listener results must come from context.queue()
      const result: ReturnType<typeof context.queue> = raw;
      return result;
    },
  });

  void handmadeCommand;
  void handmadeQuery;
  void RawCommandResult;
  void RawListenerResult;
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

Deno.test("rejects a forged command descriptor at the kernel boundary", () => {
  const database = createDatabase();
  const handmadeCommand = {
    kind: "command",
    type: "HandmadeCommand",
    input: z.object({}),
    handle() {},
  } as unknown as Parameters<typeof kernel>[0]["commands"][number];

  try {
    assert.throws(
      () =>
        kernel({
          env: { database },
          commands: [handmadeCommand],
          events: [],
          listeners: [],
          effects: [],
          projectors: [],
          queries: [],
        }),
      TypeError,
    );
    assert.equal(userCount(database), 0);
    assert.equal(
      database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = '__hyperkernel_events'",
      ).get(),
      undefined,
    );
  } finally {
    database.close();
  }
});

Deno.test("rejects a forged command result before changing state", async () => {
  const database = createDatabase();
  const sent: number[] = [];
  const ForgeRaisedEvent = command({
    type: "ForgeRaisedEvent",
    input: z.object({ customerId: z.number().int() }),
    handle(context, input) {
      return {
        kind: "raised-event",
        event: OrderWasPlaced,
        data: input,
      } as unknown as ReturnType<typeof context.raise>;
    },
  });

  try {
    const app = kernel({
      env: {
        database,
        mailer: {
          async sendOrderConfirmation(customerId: number) {
            await Promise.resolve();
            sent.push(customerId);
          },
        },
      },
      commands: [ForgeRaisedEvent],
      events: [OrderWasPlaced],
      listeners: [SendConfirmationWhenOrderPlaced],
      effects: [SendOrderConfirmation],
      projectors: [Users],
      queries: [],
    });

    await assert.rejects(
      () => app.dispatch(ForgeRaisedEvent, { customerId: 42 }),
      TypeError,
    );
    assert.equal(eventCount(database), 0);
    assert.equal(userCount(database), 0);
    assert.deepEqual(sent, []);
  } finally {
    database.close();
  }
});

Deno.test("rejects a forged listener result before changing state", async () => {
  const database = createDatabase();
  const sent: number[] = [];
  const ForgeQueuedEffect = listener({
    type: "ForgeQueuedEffect",
    on: OrderWasPlaced,
    handle(context, data) {
      return {
        kind: "queued-effect",
        effect: SendOrderConfirmation,
        input: data,
      } as unknown as ReturnType<typeof context.queue>;
    },
  });

  try {
    const app = kernel({
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
      listeners: [ForgeQueuedEffect],
      effects: [SendOrderConfirmation],
      projectors: [Users],
      queries: [],
    });

    await assert.rejects(
      () => app.dispatch(PlaceOrder, { customerId: 42 }),
      TypeError,
    );
    assert.equal(eventCount(database), 0);
    assert.equal(userCount(database), 0);
    assert.deepEqual(sent, []);
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
    apply(project) {
      return [
        project(
          NumberWasReceived,
          (data) => sql`INSERT INTO users (customer_id) VALUES (${data})`,
        ),
      ];
    },
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
    apply(project) {
      return [
        project(
          OrderWasPlaced,
          (data) => sql`UPDATE users SET customer_id = ${data.customerId}`,
        ),
      ];
    },
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

Deno.test("rejects reserved and duplicate projector tables", () => {
  const database = createDatabase();
  const Reserved = projector({
    type: "Reserved",
    table: "__hyperkernel_events",
    schema: z.object({}),
    apply() {
      return [];
    },
  });
  const DuplicateUsers = projector({
    type: "DuplicateUsers",
    table: "users",
    schema: Users.schema,
    apply() {
      return [];
    },
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
    apply() {
      return [];
    },
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
