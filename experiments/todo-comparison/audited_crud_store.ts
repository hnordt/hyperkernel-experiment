import {
  CreateTodoInputSchema,
  SetTodoCompletedInputSchema,
  TodoIdInputSchema,
  TodoSchema,
  type TodoStore,
} from "./contract.ts";
import {
  CREATE_EVENT_LOG_SQL,
  createTodoStatsReader,
  inImmediateTransaction,
  openTodoDatabase,
  parseTodoRow,
  parseTodoRows,
  runAsPromise,
} from "./database.ts";
import {
  createTodoEventLogReader,
  replayTodosAt,
  serializeTodoEvent,
  TODO_COMPLETION_CHANGED,
  TODO_CREATED,
  TODO_DELETED,
  TodoEventSchema,
  type TodoEventTimeline,
} from "./event_log.ts";

export type AuditedCrudTodoStore = TodoStore & TodoEventTimeline;

export function createAuditedCrudTodoStore(
  path: string,
): AuditedCrudTodoStore {
  const database = openTodoDatabase(path);

  try {
    database.exec(CREATE_EVENT_LOG_SQL);

    const appendEvent = database.prepare(`
      INSERT INTO __hyperkernel_events (type, data)
      VALUES (?, ?)
    `);
    const insert = database.prepare(`
      INSERT INTO todos (id, title, completed, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const get = database.prepare(`
      SELECT id, title, completed, created_at AS createdAt
      FROM todos
      WHERE id = ?
    `);
    const list = database.prepare(`
      SELECT id, title, completed, created_at AS createdAt
      FROM todos
      ORDER BY created_at, id COLLATE BINARY
    `);
    const setCompleted = database.prepare(`
      UPDATE todos
      SET completed = ?
      WHERE id = ?
    `);
    const remove = database.prepare("DELETE FROM todos WHERE id = ?");
    const eventLog = createTodoEventLogReader(database);
    const readStats = createTodoStatsReader(database, true);
    let closed = false;

    return Object.freeze(
      {
        create(input) {
          return runAsPromise(() => {
            const parsed = CreateTodoInputSchema.parse(input);
            const todo = Object.freeze(
              TodoSchema.parse({ ...parsed, completed: false }),
            );
            const event = TodoEventSchema.parse({
              type: TODO_CREATED,
              data: todo,
            });

            inImmediateTransaction(database, () => {
              appendEvent.run(event.type, serializeTodoEvent(event));
              insert.run(todo.id, todo.title, 0, todo.createdAt);
            });

            return todo;
          });
        },

        get(id) {
          const input = TodoIdInputSchema.parse({ id });
          const row = get.get(input.id);
          return row === undefined ? null : parseTodoRow(row);
        },

        list() {
          return parseTodoRows(list.all());
        },

        setCompleted(id, completed) {
          return runAsPromise(() => {
            const input = SetTodoCompletedInputSchema.parse({ id, completed });

            return inImmediateTransaction(database, () => {
              const row = get.get(input.id);
              if (row === undefined) return false;

              const current = parseTodoRow(row);
              if (current.completed === input.completed) return true;

              const event = TodoEventSchema.parse({
                type: TODO_COMPLETION_CHANGED,
                data: input,
              });
              appendEvent.run(event.type, serializeTodoEvent(event));

              const result = setCompleted.run(
                Number(input.completed),
                input.id,
              );
              if (Number(result.changes) !== 1) {
                throw new Error(
                  `Todo ${input.id} disappeared during completion`,
                );
              }

              return true;
            });
          });
        },

        remove(id) {
          return runAsPromise(() => {
            const input = TodoIdInputSchema.parse({ id });

            return inImmediateTransaction(database, () => {
              if (get.get(input.id) === undefined) return false;

              const event = TodoEventSchema.parse({
                type: TODO_DELETED,
                data: input,
              });
              appendEvent.run(event.type, serializeTodoEvent(event));

              const result = remove.run(input.id);
              if (Number(result.changes) !== 1) {
                throw new Error(
                  `Todo ${input.id} disappeared during deletion`,
                );
              }

              return true;
            });
          });
        },

        stats: readStats,
        events: eventLog.events,

        replay(position) {
          return replayTodosAt(eventLog.through(position), position);
        },

        close() {
          if (closed) return;
          closed = true;
          database.close();
        },
      } satisfies AuditedCrudTodoStore,
    );
  } catch (error) {
    database.close();
    throw error;
  }
}
