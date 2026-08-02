import { DatabaseSync } from "node:sqlite";
import {
  orderTodos,
  type Todo,
  TodoRowSchema,
  type TodoStoreStats,
} from "./contract.ts";

const TODOS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS todos (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
    completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  ) STRICT
`;

export const CREATE_EVENT_LOG_SQL = `
  CREATE TABLE IF NOT EXISTS __hyperkernel_events (
    position INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    data TEXT NOT NULL
  ) STRICT
`;

export function openTodoDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);

  try {
    const journal = database.prepare("PRAGMA journal_mode = WAL").get() as
      | { journal_mode?: unknown }
      | undefined;

    if (journal?.journal_mode !== "wal") {
      throw new Error(
        `Todo stores require a file-backed WAL database; SQLite selected ${
          String(journal?.journal_mode)
        }`,
      );
    }

    database.exec(`
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      ${TODOS_SCHEMA};
    `);

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function inImmediateTransaction<Result>(
  database: DatabaseSync,
  run: () => Result,
): Result {
  database.exec("BEGIN IMMEDIATE");

  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function runAsPromise<Result>(run: () => Result): Promise<Result> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error);
  }
}

export function parseTodoRow(row: unknown): Todo {
  return Object.freeze(TodoRowSchema.parse(row));
}

export function parseTodoRows(rows: readonly unknown[]): readonly Todo[] {
  return orderTodos(rows.map(parseTodoRow));
}

export function createTodoStatsReader(
  database: DatabaseSync,
  includesEvents: boolean,
): () => TodoStoreStats {
  const todoCount = database.prepare("SELECT count(*) AS count FROM todos");
  const eventCount = includesEvents
    ? database.prepare(
      "SELECT count(*) AS count FROM __hyperkernel_events",
    )
    : undefined;
  const journalMode = database.prepare("PRAGMA journal_mode");
  const pageCount = database.prepare("PRAGMA page_count");
  const pageSize = database.prepare("PRAGMA page_size");
  const freelistCount = database.prepare("PRAGMA freelist_count");

  return () =>
    Object.freeze({
      todoCount: readNumber(todoCount.get(), "count"),
      eventCount: eventCount === undefined
        ? 0
        : readNumber(eventCount.get(), "count"),
      journalMode: readString(journalMode.get(), "journal_mode"),
      pageCount: readNumber(pageCount.get(), "page_count"),
      pageSize: readNumber(pageSize.get(), "page_size"),
      freelistCount: readNumber(freelistCount.get(), "freelist_count"),
    });
}

function readNumber(row: unknown, column: string): number {
  if (
    typeof row !== "object" || row === null ||
    typeof (row as Record<string, unknown>)[column] !== "number"
  ) {
    throw new TypeError(`SQLite did not return numeric ${column}`);
  }

  return (row as Record<string, number>)[column];
}

function readString(row: unknown, column: string): string {
  if (
    typeof row !== "object" || row === null ||
    typeof (row as Record<string, unknown>)[column] !== "string"
  ) {
    throw new TypeError(`SQLite did not return string ${column}`);
  }

  return (row as Record<string, string>)[column];
}
