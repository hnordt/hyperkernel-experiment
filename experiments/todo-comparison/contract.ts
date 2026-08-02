import { z } from "zod";

export const TodoIdSchema = z.string().min(1).max(128).refine(
  (value) => value.isWellFormed(),
  "Todo ID must contain well-formed Unicode",
).refine(
  (value) => !value.includes("\0"),
  "Todo ID cannot contain NUL",
);
export const TodoTitleSchema = z.string().trim().min(1).max(500).refine(
  (value) => value.isWellFormed(),
  "Todo title must contain well-formed Unicode",
).refine(
  (value) => !value.includes("\0"),
  "Todo title cannot contain NUL",
);
export const TodoTimestampSchema = z.number().int().nonnegative().max(
  Number.MAX_SAFE_INTEGER,
);

export const CreateTodoInputSchema = z.object({
  id: TodoIdSchema,
  title: TodoTitleSchema,
  createdAt: TodoTimestampSchema,
}).strict();

export const TodoSchema = CreateTodoInputSchema.extend({
  completed: z.boolean(),
}).strict();

export const TodoRowSchema = z.object({
  id: TodoIdSchema,
  title: TodoTitleSchema,
  completed: z.union([z.literal(0), z.literal(1)]).transform((value) =>
    value === 1
  ),
  createdAt: TodoTimestampSchema,
}).strict();

export const TodoIdInputSchema = z.object({ id: TodoIdSchema }).strict();

export const SetTodoCompletedInputSchema = z.object({
  id: TodoIdSchema,
  completed: z.boolean(),
}).strict();

export type CreateTodoInput = Readonly<
  z.output<typeof CreateTodoInputSchema>
>;
export type Todo = Readonly<z.output<typeof TodoSchema>>;

const utf8 = new TextEncoder();

export function orderTodos(todos: readonly Todo[]): readonly Todo[] {
  return Object.freeze(
    [...todos].sort((left, right) =>
      left.createdAt - right.createdAt || compareText(left.id, right.id)
    ),
  );
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  const leftBytes = utf8.encode(left);
  const rightBytes = utf8.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);

  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] < rightBytes[index] ? -1 : 1;
    }
  }

  if (leftBytes.length === rightBytes.length) return 0;
  return leftBytes.length < rightBytes.length ? -1 : 1;
}

export type TodoStoreStats = Readonly<{
  todoCount: number;
  eventCount: number;
  journalMode: string;
  pageCount: number;
  pageSize: number;
  freelistCount: number;
}>;

export type TodoStore = Readonly<{
  create(input: CreateTodoInput): Promise<Todo>;
  get(id: string): Todo | null;
  list(): readonly Todo[];
  setCompleted(id: string, completed: boolean): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  stats(): TodoStoreStats;
  close(): void;
}>;
