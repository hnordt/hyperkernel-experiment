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
    sendOrderConfirmation(customerId: number): void;
  }>;
}>;

const SendOrderConfirmation = effect({
  type: "SendOrderConfirmation",
  input: z.object({
    customerId: z.number().int(),
  }),
  run(environment: Environment, input) {
    environment.mailer.sendOrderConfirmation(input.customerId);
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
  projectors: readonly Readonly<{
    kind: "projector";
    type: string;
    table: string;
  }>[] = [Users],
  queries: readonly Readonly<{
    kind: "query";
    type: string;
  }>[] = [GetUsers],
) {
  return kernel({
    env: {
      database,
      mailer: {
        sendOrderConfirmation(customerId: number) {
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

Deno.test("dispatches one command through event, projection, listener, and effect", () => {
  const database = createDatabase();
  const sent: number[] = [];

  try {
    const app = createApp(database, sent);

    app.dispatch(PlaceOrder, { customerId: 42 });

    assert.deepEqual(app.query(GetUsers, { limit: 10 }), [
      { customerId: 42 },
    ]);
    assert.deepEqual(sent, [42]);
    assert.equal(eventCount(database), 1);
  } finally {
    database.close();
  }
});

Deno.test("rejects invalid command input before changing state", () => {
  const database = createDatabase();
  const sent: number[] = [];

  try {
    const app = createApp(database, sent);

    assert.throws(
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

Deno.test("parses transformed event and effect values once", () => {
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
          sendOrderConfirmation() {},
        },
      },
      commands: [ReceiveNumber],
      events: [NumberWasReceived],
      listeners: [RecordReceivedNumber],
      effects: [RecordNumber],
      projectors: [Numbers],
      queries: [],
    });

    app.dispatch(ReceiveNumber, "42");

    assert.deepEqual(transformed, [42]);
    assert.equal(userCount(database), 1);
  } finally {
    database.close();
  }
});

Deno.test("rolls back earlier writes when a projector writes outside its table", () => {
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

    assert.throws(
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
