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

type EnvironmentEffect<Environment> =
  & Effect
  & Readonly<{
    run: (environment: Environment, input: never) => unknown;
  }>;

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
  return Object.freeze({ kind: "event" as const, ...definition });
}

type RaisedEvent = Readonly<{
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
  return Object.freeze({ kind: "command" as const, ...definition });
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
  return Object.freeze({ kind: "effect" as const, ...definition });
}

type QueuedEffect = Readonly<{
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
  return Object.freeze({ kind: "listener" as const, ...definition });
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
    kind: "projector" as const,
    ...definition,
    apply: Object.freeze([...definition.apply]),
  });
}

type Projector =
  & Resource<"projector">
  & Readonly<{
    table: string;
  }>;

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
    kind: "query" as const,
    ...definition,
    reads: Object.freeze([...definition.reads]) as unknown as Reads,
  });
}

type KernelOptions<Environment extends { database: DatabaseSync }> = Readonly<{
  env: Environment;
  commands: readonly Resource<"command">[];
  events: readonly Resource<"event">[];
  listeners: readonly Resource<"listener">[];
  effects: readonly EnvironmentEffect<NoInfer<Environment>>[];
  projectors: readonly Projector[];
  queries: readonly Resource<"query">[];
}>;

type RuntimeCommand =
  & Resource<"command">
  & Readonly<{
    input: ZodType;
    handle(context: CommandContext, input: unknown): RaisedEvent | undefined;
  }>;

type RuntimeEvent = Event;

type RuntimeListener =
  & Resource<"listener">
  & Readonly<{
    on: Resource<"event">;
    handle(context: ListenerContext, data: unknown): QueuedEffect | undefined;
  }>;

type RuntimeEffect =
  & Effect
  & Readonly<{
    run(environment: unknown, input: unknown): unknown;
  }>;

type RuntimeProjector =
  & Projector
  & Readonly<{
    apply: readonly Readonly<{
      on: Resource<"event">;
      sql(data: unknown): SqlStatement;
    }>[];
  }>;

type RuntimeQuery =
  & Resource<"query">
  & Readonly<{
    input: ZodType;
    reads: readonly Projector[];
    output: ZodType;
    run(input: unknown): SqlStatement;
  }>;

type ProjectionPlan = Readonly<{
  projector: RuntimeProjector;
  statement: SqlStatement;
}>;

type DispatchPlan = Readonly<{
  event: RuntimeEvent;
  serializedData: string;
  projections: readonly ProjectionPlan[];
  effects: readonly QueuedEffect[];
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

function authorizer(
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

function authorizationState(
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

function authorized<Result>(
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

function indexDefinitions<Definition extends Resource<string>>(
  definitions: readonly Definition[],
): Map<string, Definition> {
  const indexed = new Map<string, Definition>();

  for (const definition of definitions) {
    if (indexed.has(definition.type)) {
      throw new Error(`Duplicate ${definition.kind}: ${definition.type}`);
    }

    indexed.set(definition.type, definition);
  }

  return indexed;
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

function validateDefinitionReferences(
  events: ReadonlyMap<string, Resource<"event">>,
  listeners: ReadonlyMap<string, Resource<"listener">>,
  projectors: ReadonlyMap<string, Projector>,
  queries: ReadonlyMap<string, Resource<"query">>,
): void {
  for (const definition of listeners.values()) {
    const listener = definition as RuntimeListener;
    requireRegistered(events, listener.on);
  }

  for (const definition of projectors.values()) {
    const projector = definition as RuntimeProjector;

    for (const application of projector.apply) {
      requireRegistered(events, application.on);
    }
  }

  for (const definition of queries.values()) {
    const query = definition as RuntimeQuery;

    for (const dependency of query.reads) {
      requireRegistered(projectors, dependency);
    }
  }
}

function createStatementPreparer(
  database: AuthorizedDatabase,
): (scope: object, text: string) => PreparedStatement {
  // Scope identity keeps statements with different authorization policies apart.
  const statementsByScope = new Map<object, Map<string, PreparedStatement>>();

  return (scope, text) => {
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
  };
}

export function kernel<Environment extends { database: DatabaseSync }>(
  options: KernelOptions<Environment>,
) {
  const commands = indexDefinitions(options.commands);
  const events = indexDefinitions(options.events);
  const listeners = indexDefinitions(options.listeners);
  const effects = indexDefinitions(options.effects);
  const projectors = indexDefinitions(options.projectors);
  const queries = indexDefinitions(options.queries);
  validateDefinitionReferences(events, listeners, projectors, queries);
  const database = options.env.database as AuthorizedDatabase;
  const projectorTables = new Set<string>();
  const internalStatementScope = Object.freeze({});
  const prepare = createStatementPreparer(database);

  for (const definition of projectors.values()) {
    if (definition.table.startsWith("__hyperkernel_")) {
      throw new Error(`Reserved projector table: ${definition.table}`);
    }

    if (projectorTables.has(definition.table)) {
      throw new Error(`Duplicate projector table: ${definition.table}`);
    }

    projectorTables.add(definition.table);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS __hyperkernel_events (
      position INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      data TEXT NOT NULL
    ) STRICT
  `);

  const authorizers = authorizationState(database);
  const projectorAuthorizers = new Map<RuntimeProjector, Authorizer>();
  const queryAuthorizers = new Map<RuntimeQuery, Authorizer>();

  function projectorAuthorizer(projector: RuntimeProjector): Authorizer {
    let policy = projectorAuthorizers.get(projector);

    if (policy === undefined) {
      policy = authorizer(new Set([projector.table]), true);
      projectorAuthorizers.set(projector, policy);
    }

    return policy;
  }

  function queryAuthorizer(query: RuntimeQuery): Authorizer {
    let policy = queryAuthorizers.get(query);

    if (policy === undefined) {
      const tables = new Set(
        query.reads.map((dependency) =>
          requireRegistered(projectors, dependency).table
        ),
      );
      policy = authorizer(tables, false);
      queryAuthorizers.set(query, policy);
    }

    return policy;
  }

  const commandContext: CommandContext = Object.freeze({
    raise<Data extends ZodType>(definition: Event<Data>, data: z.input<Data>) {
      const event = requireRegistered(events, definition) as RuntimeEvent;
      return Object.freeze({
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
      const effect = requireRegistered(effects, definition) as RuntimeEffect;
      return Object.freeze({
        kind: "queued-effect" as const,
        effect,
        input: effect.input.parse(input),
      });
    },
  });

  function buildProjectionPlans(
    event: RuntimeEvent,
    data: unknown,
  ): ProjectionPlan[] {
    return [...projectors.values()]
      .map((definition) => definition as RuntimeProjector)
      .flatMap((projector) =>
        projector.apply
          .filter((application) => application.on === event)
          .map((application) => ({
            projector,
            statement: application.sql(data),
          }))
      );
  }

  function buildEffectPlans(
    event: RuntimeEvent,
    data: unknown,
  ): QueuedEffect[] {
    return [...listeners.values()]
      .map((definition) => definition as RuntimeListener)
      .filter((listener) => listener.on === event)
      .map((listener) => listener.handle(listenerContext, data))
      .filter((queued): queued is QueuedEffect => queued !== undefined);
  }

  function buildDispatchPlan<Input extends ZodType>(
    definition: Resource<"command"> & Readonly<{ input: Input }>,
    input: z.input<Input>,
  ): DispatchPlan | undefined {
    const command = requireRegistered(commands, definition) as RuntimeCommand;
    const raised = command.handle(commandContext, command.input.parse(input));

    if (raised === undefined) return;

    const event = requireRegistered(events, raised.event) as RuntimeEvent;
    const data = raised.data;
    const serializedData = JSON.stringify(data);

    if (serializedData === undefined) {
      throw new TypeError(`Event ${event.type} is not JSON serializable`);
    }

    // Planning runs before the transaction, so callbacks cannot partially
    // commit SQLite state if they fail.
    const projections = buildProjectionPlans(event, data);
    const effects = buildEffectPlans(event, data);

    return { event, serializedData, projections, effects };
  }

  function commitDispatch(plan: DispatchPlan): void {
    database.exec("BEGIN IMMEDIATE");

    try {
      prepare(
        internalStatementScope,
        "INSERT INTO __hyperkernel_events (type, data) VALUES (?, ?)",
      ).run(plan.event.type, plan.serializedData);

      for (const { projector, statement } of plan.projections) {
        authorized(
          authorizers,
          projectorAuthorizer(projector),
          () => prepare(projector, statement.text).run(...statement.parameters),
        );
      }

      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async function runQueuedEffects(
    queuedEffects: readonly QueuedEffect[],
  ): Promise<void> {
    for (const queued of queuedEffects) {
      const effect = requireRegistered(effects, queued.effect) as RuntimeEffect;
      await effect.run(options.env, queued.input);
    }
  }

  async function dispatch<Input extends ZodType>(
    definition: Resource<"command"> & Readonly<{ input: Input }>,
    input: z.input<Input>,
  ): Promise<void> {
    const plan = buildDispatchPlan(definition, input);

    if (plan === undefined) return;

    commitDispatch(plan);
    await runQueuedEffects(plan.effects);
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
    const query = requireRegistered(queries, definition) as RuntimeQuery;
    const statement = query.run(query.input.parse(input));
    const rows = authorized(
      authorizers,
      queryAuthorizer(query),
      () => prepare(query, statement.text).all(...statement.parameters),
    );

    return query.output.parse(rows) as z.output<Output>;
  }

  return Object.freeze({ dispatch, query: runQuery });
}
