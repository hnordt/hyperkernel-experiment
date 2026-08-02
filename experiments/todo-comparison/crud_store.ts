import {
  CreateTodoInputSchema,
  SetTodoCompletedInputSchema,
  TodoIdInputSchema,
  TodoSchema,
  type TodoStore,
} from "./contract.ts";
import {
  createTodoStatsReader,
  inImmediateTransaction,
  openTodoDatabase,
  parseTodoRow,
  parseTodoRows,
  runAsPromise,
} from "./database.ts";

export function createCrudTodoStore(path: string): TodoStore {
  const database = openTodoDatabase(path);

  try {
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
    const readStats = createTodoStatsReader(database, false);
    let closed = false;

    return Object.freeze(
      {
        create(input) {
          return runAsPromise(() => {
            const parsed = CreateTodoInputSchema.parse(input);
            const todo = Object.freeze(
              TodoSchema.parse({ ...parsed, completed: false }),
            );

            inImmediateTransaction(database, () => {
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

            return inImmediateTransaction(
              database,
              () =>
                Number(
                  setCompleted.run(Number(input.completed), input.id).changes,
                ) > 0,
            );
          });
        },

        remove(id) {
          return runAsPromise(() => {
            const input = TodoIdInputSchema.parse({ id });

            return inImmediateTransaction(
              database,
              () => Number(remove.run(input.id).changes) > 0,
            );
          });
        },

        stats: readStats,

        close() {
          if (closed) return;
          closed = true;
          database.close();
        },
      } satisfies TodoStore,
    );
  } catch (error) {
    database.close();
    throw error;
  }
}
