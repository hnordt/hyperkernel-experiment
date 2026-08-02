import { constants, type DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { z, ZodType } from "zod";
import {
  recordAuthorizerInstallation,
  recordStatementPreparation,
} from "./sqlite_instrumentation.ts";

type Resource<Kind extends string> = Readonly<{
  kind: Kind;
  type: string;
}>;

type Event<Data extends ZodType = ZodType> =
  & Resource<"event">
  & Readonly<{ data: Data }>;

type Effect<Input extends ZodType = ZodType> =
  & Resource<"effect">
  & Readonly<{ input: Input }>;

type RegisteredEffect<Environment> =
  & Effect
  & Readonly<{
    run: (environment: Environment, input: never) => unknown;
  }>;

// Schema-specific callback arguments are erased while heterogeneous
// definitions are stored, then restored at the single invocation boundary.
type ErasedCallback<Result = unknown> = (...args: never[]) => Result;

const actionToken = Symbol("hyperkernel-action");

export type SqlStatement = Readonly<{
  text: string;
  parameters: readonly SQLInputValue[];
}>;

export function sql(
  strings: TemplateStringsArray,
  ...parameters: readonly SQLInputValue[]
): SqlStatement {
  let text = strings[0] ?? "";

  for (let index = 0; index < parameters.length; index += 1) {
    text += `?${strings[index + 1] ?? ""}`;
  }

  return Object.freeze({ text, parameters: Object.freeze([...parameters]) });
}

export function event<const Type extends string, Data extends ZodType>(
  definition: Readonly<{ type: Type; data: Data }>,
) {
  return Object.freeze({ ...definition, kind: "event" as const });
}

type RaisedEvent = Readonly<{
  [actionToken]: "raised-event";
  kind: "raised-event";
  event: Resource<"event">;
  data: unknown;
}>;

export type CommandContext = Readonly<{
  raise<Data extends ZodType>(
    event: Event<Data>,
    data: z.input<Data>,
  ): RaisedEvent;
}>;

export function command<const Type extends string, Input extends ZodType>(
  definition: Readonly<{
    type: Type;
    input: Input;
    handle(
      context: CommandContext,
      input: z.output<Input>,
    ): RaisedEvent | undefined;
  }>,
) {
  return Object.freeze({ ...definition, kind: "command" as const });
}

export function effect<
  const Type extends string,
  Input extends ZodType,
  Environment,
>(
  definition: Readonly<{
    type: Type;
    input: Input;
    run(environment: Environment, input: z.output<Input>): unknown;
  }>,
) {
  return Object.freeze({ ...definition, kind: "effect" as const });
}

type QueuedEffect = Readonly<{
  [actionToken]: "queued-effect";
  kind: "queued-effect";
  effect: Resource<"effect">;
  input: unknown;
}>;

export type ListenerContext = Readonly<{
  queue<Input extends ZodType>(
    effect: Effect<Input>,
    input: z.input<Input>,
  ): QueuedEffect;
}>;

export function listener<
  const Type extends string,
  Data extends ZodType,
>(
  definition: Readonly<{
    type: Type;
    on: Event<Data>;
    handle(
      context: ListenerContext,
      data: z.output<Data>,
    ): QueuedEffect | undefined;
  }>,
) {
  return Object.freeze({ ...definition, kind: "listener" as const });
}

type ProjectionRule = Readonly<{
  on: Event;
  sql(data: never): SqlStatement;
}>;

export function project<Data extends ZodType>(
  on: Event<Data>,
  build: (data: z.output<Data>) => SqlStatement,
): ProjectionRule {
  return Object.freeze({ on, sql: build });
}

export function projector<const Type extends string, Schema extends ZodType>(
  definition: Readonly<{
    type: Type;
    table: string;
    schema: Schema;
    apply: readonly ProjectionRule[];
  }>,
) {
  return Object.freeze({
    ...definition,
    kind: "projector" as const,
    apply: Object.freeze([...definition.apply]),
  });
}

type Projector =
  & Resource<"projector">
  & Readonly<{
    table: string;
  }>;

function frozenCopy<const Items extends readonly unknown[]>(
  items: Items,
): readonly [...Items] {
  return Object.freeze([...items]);
}

export function query<
  const Type extends string,
  Input extends ZodType,
  Output extends ZodType,
  const Reads extends readonly Projector[],
>(
  definition: Readonly<{
    type: Type;
    input: Input;
    reads: Reads;
    output: Output;
    run(input: z.output<Input>): SqlStatement;
  }>,
) {
  return Object.freeze({
    ...definition,
    kind: "query" as const,
    reads: frozenCopy(definition.reads),
  });
}

type RegisteredCommand =
  & Resource<"command">
  & Readonly<{
    input: ZodType;
    handle: ErasedCallback<RaisedEvent | undefined>;
  }>;

type RegisteredListener =
  & Resource<"listener">
  & Readonly<{
    on: Event;
    handle: ErasedCallback<QueuedEffect | undefined>;
  }>;

type RegisteredProjector =
  & Projector
  & Readonly<{
    schema: ZodType;
    apply: readonly ProjectionRule[];
  }>;

type RegisteredQuery =
  & Resource<"query">
  & Readonly<{
    input: ZodType;
    reads: readonly Projector[];
    output: ZodType;
    run: ErasedCallback<SqlStatement>;
  }>;

type KernelOptions<Environment extends { database: DatabaseSync }> = Readonly<{
  env: Environment;
  commands: readonly RegisteredCommand[];
  events: readonly Event[];
  listeners: readonly RegisteredListener[];
  effects: readonly RegisteredEffect<NoInfer<Environment>>[];
  projectors: readonly RegisteredProjector[];
  queries: readonly RegisteredQuery[];
}>;

type Authorizer = (
  action: number,
  name: string | null,
  column: string | null,
  database: string | null,
  triggerOrView: string | null,
) => number;

type AuthorizedDatabase =
  & DatabaseSync
  & Readonly<{
    setAuthorizer(authorizer: Authorizer | null): void;
  }>;

type PreparedStatement = ReturnType<DatabaseSync["prepare"]>;

type AuthorizationState = {
  active: Authorizer | null;
  external: Authorizer | null;
};

const maxCachedStatementsPerScope = 64;

// Deno 2.9 implements SQLite authorization, while its node:sqlite types lag.
const authorization = constants as
  & typeof constants
  & Readonly<{
    SQLITE_DELETE: number;
    SQLITE_DENY: number;
    SQLITE_FUNCTION: number;
    SQLITE_INSERT: number;
    SQLITE_OK: number;
    SQLITE_READ: number;
    SQLITE_RECURSIVE: number;
    SQLITE_SELECT: number;
    SQLITE_UPDATE: number;
  }>;

const commonActions = new Set([
  authorization.SQLITE_FUNCTION,
  authorization.SQLITE_RECURSIVE,
  authorization.SQLITE_SELECT,
]);

const writeActions = new Set([
  authorization.SQLITE_DELETE,
  authorization.SQLITE_INSERT,
  authorization.SQLITE_UPDATE,
]);

const authorizationStates = new WeakMap<
  AuthorizedDatabase,
  AuthorizationState
>();

function createTableAuthorizer(
  tables: ReadonlySet<string>,
  writes: boolean,
): Authorizer {
  return (action, table, _column, database) => {
    if (commonActions.has(action)) {
      return authorization.SQLITE_OK;
    }

    const ownsTable = (database === null || database === "main") &&
      table !== null && tables.has(table);

    if (action === authorization.SQLITE_READ && ownsTable) {
      return authorization.SQLITE_OK;
    }

    if (writes && writeActions.has(action) && ownsTable) {
      return authorization.SQLITE_OK;
    }

    return authorization.SQLITE_DENY;
  };
}

function getAuthorizationState(
  database: AuthorizedDatabase,
): AuthorizationState {
  let state = authorizationStates.get(database);

  if (state === undefined) {
    state = { active: null, external: null };
    const installedState = state;
    const setAuthorizer = database.setAuthorizer.bind(database);
    const installedAuthorizer: Authorizer = (...args) => {
      const decision = installedState.active?.(...args);

      if (decision !== undefined && decision !== authorization.SQLITE_OK) {
        return decision;
      }

      return installedState.external?.(...args) ?? authorization.SQLITE_OK;
    };

    setAuthorizer(installedAuthorizer);
    recordAuthorizerInstallation();

    // Keep the kernel callback installed when application code changes the
    // connection authorizer, and retain native statement invalidation.
    Object.defineProperty(database, "setAuthorizer", {
      configurable: true,
      value(external: Authorizer | null) {
        installedState.external = external;
        setAuthorizer(installedAuthorizer);
        recordAuthorizerInstallation();
      },
    });
    authorizationStates.set(database, state);
  }

  return state;
}

function withAuthorization<Result>(
  state: AuthorizationState,
  policy: Authorizer,
  run: () => Result,
): Result {
  const previous = state.active;
  state.active = policy;

  try {
    // SQLite can recompile during execution after a schema change.
    return run();
  } finally {
    state.active = previous;
  }
}

function indexByType<
  Kind extends string,
  Definition extends Resource<Kind>,
>(
  kind: Kind,
  definitions: readonly Definition[],
): Map<string, Definition> {
  const definitionsByType = new Map<string, Definition>();

  for (const definition of definitions) {
    if (definition.kind !== kind) {
      throw new Error(`Invalid ${kind} kind: ${definition.kind}`);
    }

    if (definitionsByType.has(definition.type)) {
      throw new Error(`Duplicate ${kind} type: ${definition.type}`);
    }

    definitionsByType.set(definition.type, definition);
  }

  return definitionsByType;
}

function requireRegistered<Definition extends Resource<string>>(
  definitions: ReadonlyMap<string, Definition>,
  expected: Resource<string>,
): Definition {
  const actual = definitions.get(expected.type);

  if (actual !== expected) {
    throw new Error(`Unregistered ${expected.kind}: ${expected.type}`);
  }

  return actual;
}

function invoke<Result>(
  callback: ErasedCallback<Result>,
  ...args: unknown[]
): Result {
  return (callback as (...args: unknown[]) => Result)(...args);
}

type Action = RaisedEvent | QueuedEffect;

function requireAction<Kind extends Action["kind"]>(
  value: unknown,
  kind: Kind,
): Extract<Action, { kind: Kind }> {
  const token = value !== null && typeof value === "object"
    ? (value as { [actionToken]?: unknown })[actionToken]
    : undefined;

  if (token !== kind) {
    throw new TypeError(`Invalid ${kind} returned by handler`);
  }

  return value as Extract<Action, { kind: Kind }>;
}

export function kernel<Environment extends { database: DatabaseSync }>(
  options: KernelOptions<Environment>,
) {
  const commands = indexByType("command", options.commands);
  const events = indexByType("event", options.events);
  const listeners = indexByType("listener", options.listeners);
  const effects = indexByType("effect", options.effects);
  const projectors = indexByType("projector", options.projectors);
  const queries = indexByType("query", options.queries);
  const database = options.env.database as AuthorizedDatabase;
  const projectorTables = new Set<string>();
  const eventLogStatementScope = Object.freeze({});
  // Scope identity prevents identical SQL from crossing authorization bounds.
  const statementsByScope = new Map<object, Map<string, PreparedStatement>>();

  function prepareCached(scope: object, text: string): PreparedStatement {
    let statements = statementsByScope.get(scope);

    if (statements === undefined) {
      statements = new Map();
      statementsByScope.set(scope, statements);
    }

    const cached = statements.get(text);

    if (cached !== undefined) {
      statements.delete(text);
      statements.set(text, cached);
      return cached;
    }

    recordStatementPreparation();
    const statement = database.prepare(text);
    statements.set(text, statement);

    if (statements.size > maxCachedStatementsPerScope) {
      const leastRecentlyUsed = statements.keys().next().value;

      if (leastRecentlyUsed !== undefined) {
        statements.delete(leastRecentlyUsed);
      }
    }

    return statement;
  }

  for (const definition of projectors.values()) {
    if (definition.table.startsWith("__hyperkernel_")) {
      throw new Error(`Reserved projector table: ${definition.table}`);
    }

    if (projectorTables.has(definition.table)) {
      throw new Error(`Duplicate projector table: ${definition.table}`);
    }

    projectorTables.add(definition.table);

    for (const application of definition.apply) {
      requireRegistered(events, application.on);
    }
  }

  for (const definition of listeners.values()) {
    requireRegistered(events, definition.on);
  }

  for (const definition of queries.values()) {
    for (const dependency of definition.reads) {
      requireRegistered(projectors, dependency);
    }
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS __hyperkernel_events (
      position INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      data TEXT NOT NULL
    ) STRICT
  `);

  const authorizationState = getAuthorizationState(database);
  const projectorAuthorizers = new Map<RegisteredProjector, Authorizer>();
  const queryAuthorizers = new Map<RegisteredQuery, Authorizer>();

  function projectorAuthorizer(projector: RegisteredProjector): Authorizer {
    let policy = projectorAuthorizers.get(projector);

    if (policy === undefined) {
      policy = createTableAuthorizer(new Set([projector.table]), true);
      projectorAuthorizers.set(projector, policy);
    }

    return policy;
  }

  function queryAuthorizer(query: RegisteredQuery): Authorizer {
    let policy = queryAuthorizers.get(query);

    if (policy === undefined) {
      const tables = new Set(
        query.reads.map((dependency) =>
          requireRegistered(projectors, dependency).table
        ),
      );
      policy = createTableAuthorizer(tables, false);
      queryAuthorizers.set(query, policy);
    }

    return policy;
  }

  const commandContext: CommandContext = Object.freeze({
    raise<Data extends ZodType>(definition: Event<Data>, data: z.input<Data>) {
      const event = requireRegistered(events, definition);
      return Object.freeze({
        [actionToken]: "raised-event" as const,
        kind: "raised-event" as const,
        event,
        data: event.data.parse(data),
      });
    },
  });

  const listenerContext: ListenerContext = Object.freeze({
    queue<Input extends ZodType>(
      definition: Effect<Input>,
      input: z.input<Input>,
    ) {
      const effect = requireRegistered(effects, definition);
      return Object.freeze({
        [actionToken]: "queued-effect" as const,
        kind: "queued-effect" as const,
        effect,
        input: effect.input.parse(input),
      });
    },
  });

  type DispatchPlan = Readonly<{
    serialized: string;
    projections: readonly Readonly<{
      projector: RegisteredProjector;
      statement: SqlStatement;
    }>[];
    effects: readonly Readonly<{
      effect: RegisteredEffect<NoInfer<Environment>>;
      input: unknown;
    }>[];
  }>;

  function planDispatch(event: Event, data: unknown): DispatchPlan {
    const serialized = JSON.stringify(data);

    if (serialized === undefined) {
      throw new TypeError(`Event ${event.type} is not JSON serializable`);
    }

    const projections: {
      projector: RegisteredProjector;
      statement: SqlStatement;
    }[] = [];

    for (const projector of projectors.values()) {
      for (const application of projector.apply) {
        if (application.on !== event) continue;
        projections.push({
          projector,
          statement: invoke(application.sql, data),
        });
      }
    }

    const plannedEffects: {
      effect: RegisteredEffect<NoInfer<Environment>>;
      input: unknown;
    }[] = [];

    for (const listener of listeners.values()) {
      if (listener.on !== event) continue;

      const result = invoke(listener.handle, listenerContext, data);
      if (result === undefined) continue;

      const queued = requireAction(result, "queued-effect");
      plannedEffects.push({
        effect: requireRegistered(effects, queued.effect),
        input: queued.input,
      });
    }

    return { serialized, projections, effects: plannedEffects };
  }

  function persistDispatch(event: Event, plan: DispatchPlan): void {
    database.exec("BEGIN IMMEDIATE");

    try {
      prepareCached(
        eventLogStatementScope,
        "INSERT INTO __hyperkernel_events (type, data) VALUES (?, ?)",
      ).run(event.type, plan.serialized);

      for (const { projector, statement } of plan.projections) {
        withAuthorization(
          authorizationState,
          projectorAuthorizer(projector),
          () =>
            prepareCached(projector, statement.text).run(
              ...statement.parameters,
            ),
        );
      }

      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async function runEffects(plan: DispatchPlan): Promise<void> {
    for (const planned of plan.effects) {
      await invoke(planned.effect.run, options.env, planned.input);
    }
  }

  async function dispatch<Input extends ZodType>(
    definition: Resource<"command"> & Readonly<{ input: Input }>,
    input: z.input<Input>,
  ): Promise<void> {
    const command = requireRegistered(commands, definition);
    const result = invoke(
      command.handle,
      commandContext,
      command.input.parse(input),
    );

    if (result === undefined) return;

    const raised = requireAction(result, "raised-event");
    const event = requireRegistered(events, raised.event);
    const plan = planDispatch(event, raised.data);
    persistDispatch(event, plan);
    await runEffects(plan);
  }

  function runQuery<Input extends ZodType, Output extends ZodType>(
    definition:
      & Resource<"query">
      & Readonly<{
        input: Input;
        output: Output;
      }>,
    input: z.input<Input>,
  ): z.output<Output> {
    const query = requireRegistered(queries, definition);
    const statement = invoke(query.run, query.input.parse(input));
    const rows = withAuthorization(
      authorizationState,
      queryAuthorizer(query),
      () => prepareCached(query, statement.text).all(...statement.parameters),
    );

    return query.output.parse(rows) as z.output<Output>;
  }

  return Object.freeze({ dispatch, query: runQuery });
}
