# Hyperkernel experiment

A deliberately small experiment for synchronous commands, events, effects,
SQLite projectors, and typed queries.

The implementation uses:

- Deno for dependency management, formatting, checks, and tests
- Zod for runtime input and output validation
- Deno's built-in synchronous `node:sqlite` API
- One SQLite connection and one writer

## Example

```ts
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

const database = new DatabaseSync(":memory:");

// Migrations remain application-owned in this first experiment.
database.exec(`
  CREATE TABLE users (
    customer_id INTEGER PRIMARY KEY
  ) STRICT
`);

const OrderWasPlaced = event({
  type: "OrderWasPlaced",
  data: z.object({ customerId: z.number().int() }),
});

const PlaceOrder = command({
  type: "PlaceOrder",
  input: z.object({ customerId: z.number().int() }),
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
  input: z.object({ customerId: z.number().int() }),
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
  schema: z.object({ customerId: z.number().int() }),
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
  input: z.object({ limit: z.number().int().positive() }),
  reads: [Users],
  output: z.array(Users.schema),
  run(input) {
    return sql`
      SELECT customer_id AS customerId
      FROM users
      LIMIT ${input.limit}
    `;
  },
});

const app = kernel({
  env: {
    database,
    mailer: {
      sendOrderConfirmation(customerId) {
        console.log("Send confirmation to", customerId);
      },
    },
  },
  commands: [PlaceOrder],
  events: [OrderWasPlaced],
  listeners: [SendConfirmationWhenOrderPlaced],
  effects: [SendOrderConfirmation],
  projectors: [Users],
  queries: [GetUsers],
});

app.dispatch(PlaceOrder, { customerId: 42 });

console.log(app.query(GetUsers, { limit: 10 }));
```

## Synchronous flow

`dispatch()` performs one deterministic sequence:

1. Parse the command input.
2. Run its handler and validate the raised event.
3. Build projector SQL and queued effect descriptions.
4. Start `BEGIN IMMEDIATE`.
5. Append the event and update its projectors.
6. Commit the SQLite transaction.
7. Run queued effects synchronously through `env`.

If projection SQL fails, the event and every projection update roll back.
Effects run after commit, so an effect failure cannot undo the accepted event.

In this version, `queue()` means "run after commit in the same `dispatch()`
call." It is not a durable or asynchronous queue.

## SQL boundaries

Projectors and queries return SQL descriptions; they never receive the database
connection.

- A projector may read or write only its own `table`.
- A query may only select from the projectors listed in `reads`.
- Query writes, undeclared reads, DDL, pragmas, and transaction statements are
  denied by SQLite's authorizer.
- SQL template substitutions become bound parameters.

`projector.schema` is the Zod row contract. It is not a migration DSL. SQLite
tables, constraints, and indexes remain explicitly defined by the application.

## Deliberately omitted

This first version does not include modules, async handlers, multiple events per
command, multiple effects per listener, rejection results, migrations, replay,
projection checkpoints, an outbox, retries, idempotency, or concurrency.

## Development

```sh
deno task check
```
