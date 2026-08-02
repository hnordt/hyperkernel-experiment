import { z } from "zod";
import { command, event, kernel, projector, query, sql } from "../../mod.ts";
import {
  CreateTodoInputSchema,
  orderTodos,
  SetTodoCompletedInputSchema,
  TodoIdInputSchema,
  TodoRowSchema,
  TodoSchema,
  type TodoStore,
} from "./contract.ts";
import { createTodoStatsReader, openTodoDatabase } from "./database.ts";
import {
  createTodoEventLogReader,
  replayTodosAt,
  TODO_COMPLETION_CHANGED,
  TODO_CREATED,
  TODO_DELETED,
  TodoCompletionChangedDataSchema,
  TodoCreatedDataSchema,
  TodoDeletedDataSchema,
  type TodoEventTimeline,
} from "./event_log.ts";

const TodoCreated = event({
  type: TODO_CREATED,
  data: TodoCreatedDataSchema,
});

const TodoCompletionChanged = event({
  type: TODO_COMPLETION_CHANGED,
  data: TodoCompletionChangedDataSchema,
});

const TodoDeleted = event({
  type: TODO_DELETED,
  data: TodoDeletedDataSchema,
});

const CreateTodo = command({
  type: "CreateTodo",
  input: CreateTodoInputSchema,
  handle(context, input) {
    return context.raise(TodoCreated, { ...input, completed: false });
  },
});

const ChangeTodoCompletion = command({
  type: "ChangeTodoCompletion",
  input: SetTodoCompletedInputSchema,
  handle(context, input) {
    return context.raise(TodoCompletionChanged, input);
  },
});

const DeleteTodo = command({
  type: "DeleteTodo",
  input: TodoIdInputSchema,
  handle(context, input) {
    return context.raise(TodoDeleted, input);
  },
});

const Todos = projector({
  type: "Todos",
  table: "todos",
  schema: TodoRowSchema,
  apply(project) {
    return [
      project(
        TodoCreated,
        (data) =>
          sql`
            INSERT INTO todos (id, title, completed, created_at)
            VALUES (${data.id}, ${data.title}, ${
            Number(data.completed)
          }, ${data.createdAt})
          `,
      ),
      project(
        TodoCompletionChanged,
        (data) =>
          sql`
            UPDATE todos
            SET completed = ${Number(data.completed)}
            WHERE id = ${data.id}
          `,
      ),
      project(
        TodoDeleted,
        (data) => sql`DELETE FROM todos WHERE id = ${data.id}`,
      ),
    ];
  },
});

const GetTodo = query({
  type: "GetTodo",
  input: TodoIdInputSchema,
  reads: [Todos],
  output: z.array(TodoRowSchema).max(1).transform((rows) => rows[0] ?? null),
  run(input) {
    return sql`
      SELECT id, title, completed, created_at AS createdAt
      FROM todos
      WHERE id = ${input.id}
    `;
  },
});

const ListTodos = query({
  type: "ListTodos",
  input: z.object({}).strict(),
  reads: [Todos],
  output: z.array(TodoRowSchema),
  run() {
    return sql`
      SELECT id, title, completed, created_at AS createdAt
      FROM todos
      ORDER BY created_at, id COLLATE BINARY
    `;
  },
});

export type HyperkernelTodoStore = TodoStore & TodoEventTimeline;

export function createHyperkernelTodoStore(
  path: string,
): HyperkernelTodoStore {
  const database = openTodoDatabase(path);

  try {
    const app = kernel({
      env: { database },
      commands: [CreateTodo, ChangeTodoCompletion, DeleteTodo],
      events: [TodoCreated, TodoCompletionChanged, TodoDeleted],
      listeners: [],
      effects: [],
      projectors: [Todos],
      queries: [GetTodo, ListTodos],
    });
    const eventLog = createTodoEventLogReader(database);
    const readStats = createTodoStatsReader(database, true);
    let closed = false;

    return Object.freeze(
      {
        async create(input) {
          const parsed = CreateTodoInputSchema.parse(input);
          const todo = Object.freeze(
            TodoSchema.parse({ ...parsed, completed: false }),
          );

          await app.dispatch(CreateTodo, parsed);
          return todo;
        },

        get(id) {
          const todo = app.query(GetTodo, { id });
          return todo === null ? null : Object.freeze(todo);
        },

        list() {
          return orderTodos(
            app.query(ListTodos, {}).map((todo) => Object.freeze(todo)),
          );
        },

        async setCompleted(id, completed) {
          const input = SetTodoCompletedInputSchema.parse({ id, completed });
          const current = app.query(GetTodo, { id: input.id });

          // There is deliberately no await between this read and dispatch. With
          // the experiment's only writer on this connection, the precondition
          // remains true until the kernel commits the event and projection.
          if (current === null) return false;
          if (current.completed === input.completed) return true;

          await app.dispatch(ChangeTodoCompletion, input);
          return true;
        },

        async remove(id) {
          const input = TodoIdInputSchema.parse({ id });
          const current = app.query(GetTodo, input);

          // See setCompleted(): this pre-read is safe only under the explicit
          // one-connection, one-writer model used by the comparison.
          if (current === null) return false;

          await app.dispatch(DeleteTodo, input);
          return true;
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
      } satisfies HyperkernelTodoStore,
    );
  } catch (error) {
    database.close();
    throw error;
  }
}
