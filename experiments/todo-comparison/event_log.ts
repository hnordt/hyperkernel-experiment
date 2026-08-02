import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  CreateTodoInputSchema,
  orderTodos,
  type Todo,
  TodoIdSchema,
  TodoSchema,
} from "./contract.ts";

export const TODO_CREATED = "TodoCreated" as const;
export const TODO_COMPLETION_CHANGED = "TodoCompletionChanged" as const;
export const TODO_DELETED = "TodoDeleted" as const;

export const TodoCreatedDataSchema = CreateTodoInputSchema.extend({
  completed: z.literal(false),
}).strict();

export const TodoCompletionChangedDataSchema = z.object({
  id: TodoIdSchema,
  completed: z.boolean(),
}).strict();

export const TodoDeletedDataSchema = z.object({ id: TodoIdSchema }).strict();

export const TodoEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(TODO_CREATED),
    data: TodoCreatedDataSchema,
  }).strict(),
  z.object({
    type: z.literal(TODO_COMPLETION_CHANGED),
    data: TodoCompletionChangedDataSchema,
  }).strict(),
  z.object({
    type: z.literal(TODO_DELETED),
    data: TodoDeletedDataSchema,
  }).strict(),
]);

const EventPositionInLogSchema = z.number().int().positive().max(
  Number.MAX_SAFE_INTEGER,
);

const StoredTodoEventSchema = z.discriminatedUnion("type", [
  z.object({
    position: EventPositionInLogSchema,
    type: z.literal(TODO_CREATED),
    data: TodoCreatedDataSchema,
  }).strict(),
  z.object({
    position: EventPositionInLogSchema,
    type: z.literal(TODO_COMPLETION_CHANGED),
    data: TodoCompletionChangedDataSchema,
  }).strict(),
  z.object({
    position: EventPositionInLogSchema,
    type: z.literal(TODO_DELETED),
    data: TodoDeletedDataSchema,
  }).strict(),
]);

const RawEventRowSchema = z.object({
  position: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  type: z.string(),
  data: z.string(),
}).strict();

const EventPositionSchema = z.number().int().nonnegative().max(
  Number.MAX_SAFE_INTEGER,
);
const EventPageSizeSchema = z.number().int().positive().max(1_000);

export type TodoEvent = Readonly<z.output<typeof TodoEventSchema>>;
export type StoredTodoEvent = Readonly<
  z.output<typeof StoredTodoEventSchema>
>;

export type TodoEventLogReader = Readonly<{
  events(after?: number, limit?: number): readonly StoredTodoEvent[];
  through(position?: number): readonly StoredTodoEvent[];
  count(): number;
}>;

export type TodoEventTimeline = Readonly<{
  events(after?: number, limit?: number): readonly StoredTodoEvent[];
  replay(position?: number): readonly Todo[];
}>;

export function serializeTodoEvent(event: TodoEvent): string {
  const validated = TodoEventSchema.parse(event);
  const serialized = JSON.stringify(validated.data);

  if (serialized === undefined) {
    throw new TypeError(`Event ${validated.type} is not JSON serializable`);
  }

  return serialized;
}

export function createTodoEventLogReader(
  database: DatabaseSync,
): TodoEventLogReader {
  const page = database.prepare(`
    SELECT position, type, data
    FROM __hyperkernel_events
    WHERE position > ?
    ORDER BY position
    LIMIT ?
  `);
  const through = database.prepare(`
    SELECT position, type, data
    FROM __hyperkernel_events
    WHERE position <= ?
    ORDER BY position
  `);
  const count = database.prepare(`
    SELECT count(*) AS count
    FROM __hyperkernel_events
  `);

  return Object.freeze({
    events(after = 0, limit = 100) {
      return decodeRows(
        page.all(
          EventPositionSchema.parse(after),
          EventPageSizeSchema.parse(limit),
        ),
      );
    },

    through(position = Number.MAX_SAFE_INTEGER) {
      return decodeRows(through.all(EventPositionSchema.parse(position)));
    },

    count() {
      const row = count.get() as { count: number };
      return row.count;
    },
  });
}

export function replayTodosAt(
  events: readonly StoredTodoEvent[],
  position = Number.MAX_SAFE_INTEGER,
): readonly Todo[] {
  const through = EventPositionSchema.parse(position);
  const todos = new Map<string, Todo>();
  let previousPosition = 0;

  for (const event of events) {
    if (event.position <= previousPosition) {
      throw new Error("Todo events must be ordered by increasing position");
    }

    previousPosition = event.position;
    if (event.position > through) break;

    switch (event.type) {
      case TODO_CREATED: {
        if (todos.has(event.data.id)) {
          throw new Error(`Todo ${event.data.id} was created twice`);
        }

        todos.set(event.data.id, Object.freeze(TodoSchema.parse(event.data)));
        break;
      }

      case TODO_COMPLETION_CHANGED: {
        const todo = todos.get(event.data.id);

        if (todo === undefined) {
          throw new Error(
            `Todo ${event.data.id} changed completion before creation`,
          );
        }

        todos.set(
          event.data.id,
          Object.freeze({ ...todo, completed: event.data.completed }),
        );
        break;
      }

      case TODO_DELETED:
        if (!todos.delete(event.data.id)) {
          throw new Error(`Todo ${event.data.id} was deleted before creation`);
        }
        break;
    }
  }

  return orderTodos([...todos.values()]);
}

function decodeRows(rows: readonly unknown[]): readonly StoredTodoEvent[] {
  return Object.freeze(rows.map(decodeRow));
}

function decodeRow(row: unknown): StoredTodoEvent {
  const raw = RawEventRowSchema.parse(row);
  let data: unknown;

  try {
    data = JSON.parse(raw.data);
  } catch (cause) {
    throw new SyntaxError(
      `Event at position ${raw.position} contains invalid JSON`,
      { cause },
    );
  }

  return Object.freeze(StoredTodoEventSchema.parse({ ...raw, data }));
}
