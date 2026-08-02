import { constants, type DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { z, ZodType } from "zod";
import {
  recordAuthorizerInstallation,
  recordStatementPreparation,
} from "./sqlite_instrumentation.ts";

declare const definitionBrand: unique symbol;

type DefinitionHandle<Kind extends string, Contract> = Readonly<{
  [definitionBrand]: Readonly<{
    kind: Kind;
    contract: Contract;
  }>;
}>;

type Event<Data extends ZodType = ZodType> =
  & DefinitionHandle<"event", Data>
  & Readonly<{ type: string }>;

type Command<Input extends ZodType = ZodType> = DefinitionHandle<
  "command",
  Input
>;

type Effect<
  Input extends ZodType = ZodType,
  Environment = unknown,
> = DefinitionHandle<
  "effect",
  Readonly<{
    input: Input;
    environment: (environment: Environment) => void;
  }>
>;

type EnvironmentEffect<Environment> = Effect<ZodType, Environment>;

type Listener<Data extends ZodType = ZodType> = DefinitionHandle<
  "listener",
  Data
>;

type Projector<Schema extends ZodType = ZodType> =
  & DefinitionHandle<"projector", Schema>
  & Readonly<{ schema: Schema }>;

type Query<
  Input extends ZodType = ZodType,
  Output extends ZodType = ZodType,
> = DefinitionHandle<
  "query",
  Readonly<{ input: Input; output: Output }>
>;

declare const raisedEventBrand: unique symbol;

type RaisedEvent = Readonly<{
  [raisedEventBrand]: true;
}>;

declare const queuedEffectBrand: unique symbol;

type QueuedEffect = Readonly<{
  [queuedEffectBrand]: true;
}>;

declare const projectionRuleBrand: unique symbol;

type ProjectionRule = Readonly<{
  [projectionRuleBrand]: true;
}>;

type Project = <Data extends ZodType>(
  on: Event<Data>,
  build: (data: z.output<Data>) => SqlStatement,
) => ProjectionRule;

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
): Event<Data> & Readonly<{ type: Type }> {
  const handle = Object.freeze({ type: definition.type }) as
    & Event<Data>
    & Readonly<{ type: Type }>;

  return registerDefinition(handle, {
    kind: "event",
    type: definition.type,
    data: definition.data,
  });
}

type CommandContext = Readonly<{
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
): Command<Input> {
  const handle = Object.freeze({}) as Command<Input>;

  return registerDefinition(handle, {
    kind: "command",
    type: definition.type,
    input: definition.input,
    handle: definition.handle as RuntimeCommand["handle"],
  });
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
): Effect<Input, Environment> {
  const handle = Object.freeze({}) as Effect<Input, Environment>;

  return registerDefinition(handle, {
    kind: "effect",
    type: definition.type,
    input: definition.input,
    run: definition.run as RuntimeEffect["run"],
  });
}

type ListenerContext = Readonly<{
  queue<Input extends ZodType, Environment>(
    effect: Effect<Input, Environment>,
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
): Listener<Data> {
  const handle = Object.freeze({}) as Listener<Data>;

  return registerDefinition(handle, {
    kind: "listener",
    type: definition.type,
    on: definition.on,
    handle: definition.handle as RuntimeListener["handle"],
  });
}

export function projector<const Type extends string, Schema extends ZodType>(
  definition: Readonly<{
    type: Type;
    table: string;
    schema: Schema;
    apply(project: Project): readonly ProjectionRule[];
  }>,
): Projector<Schema> {
  const projectionDefinitions = new WeakMap<
    ProjectionRule,
    RuntimeProjectionRule
  >();
  const project: Project = <Data extends ZodType>(
    on: Event<Data>,
    build: (data: z.output<Data>) => SqlStatement,
  ) => {
    runtimeDefinition(on, "event");
    const rule = Object.freeze({}) as ProjectionRule;
    projectionDefinitions.set(
      rule,
      Object.freeze({
        on,
        sql: build as RuntimeProjectionRule["sql"],
      }),
    );
    return rule;
  };
  const apply = definition.apply(project).map((rule) => {
    const application = projectionDefinitions.get(rule);

    if (application === undefined) {
      throw new TypeError("Invalid projection rule");
    }

    return application;
  });
  const handle = Object.freeze({ schema: definition.schema }) as Projector<
    Schema
  >;

  return registerDefinition(handle, {
    kind: "projector",
    type: definition.type,
    table: definition.table,
    apply: Object.freeze(apply),
  });
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
): Query<Input, Output> {
  const handle = Object.freeze({}) as Query<Input, Output>;

  return registerDefinition(handle, {
    kind: "query",
    type: definition.type,
    input: definition.input,
    reads: Object.freeze([...definition.reads]),
    output: definition.output,
    run: definition.run as RuntimeQuery["run"],
  });
}

type KernelOptions<Environment extends { database: DatabaseSync }> = Readonly<{
  env: Environment;
  commands: readonly Command[];
  events: readonly Event[];
  listeners: readonly Listener[];
  effects: readonly EnvironmentEffect<NoInfer<Environment>>[];
  projectors: readonly Projector[];
  queries: readonly Query[];
}>;

type RuntimeCommand = Readonly<{
  kind: "command";
  type: string;
  input: ZodType;
  handle(context: CommandContext, input: unknown): RaisedEvent | undefined;
}>;

type RuntimeEvent = Readonly<{
  kind: "event";
  type: string;
  data: ZodType;
}>;

type RuntimeListener = Readonly<{
  kind: "listener";
  type: string;
  on: Event;
  handle(context: ListenerContext, data: unknown): QueuedEffect | undefined;
}>;

type RuntimeEffect = Readonly<{
  kind: "effect";
  type: string;
  input: ZodType;
  run(environment: unknown, input: unknown): unknown;
}>;

type RuntimeProjectionRule = Readonly<{
  on: Event;
  sql(data: unknown): SqlStatement;
}>;

type RuntimeProjector = Readonly<{
  kind: "projector";
  type: string;
  table: string;
  apply: readonly RuntimeProjectionRule[];
}>;

type RuntimeQuery = Readonly<{
  kind: "query";
  type: string;
  input: ZodType;
  reads: readonly Projector[];
  output: ZodType;
  run(input: unknown): SqlStatement;
}>;

type RuntimeDefinition =
  | RuntimeCommand
  | RuntimeEffect
  | RuntimeEvent
  | RuntimeListener
  | RuntimeProjector
  | RuntimeQuery;

const definitionRegistry = new WeakMap<object, RuntimeDefinition>();

function registerDefinition<Handle extends object>(
  handle: Handle,
  definition: RuntimeDefinition,
): Handle {
  definitionRegistry.set(handle, Object.freeze(definition));
  return handle;
}

function runtimeDefinition<Kind extends RuntimeDefinition["kind"]>(
  handle: object,
  kind: Kind,
): Extract<RuntimeDefinition, Readonly<{ kind: Kind }>> {
  const definition = definitionRegistry.get(handle);

  if (definition?.kind !== kind) {
    throw new TypeError(`Invalid ${kind} definition`);
  }

  return definition as Extract<RuntimeDefinition, Readonly<{ kind: Kind }>>;
}

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

function index<Kind extends RuntimeDefinition["kind"]>(
  handles: readonly object[],
  kind: Kind,
): Map<string, object> {
  return new Map(
    handles.map((handle) => [runtimeDefinition(handle, kind).type, handle]),
  );
}

function registered<Kind extends RuntimeDefinition["kind"]>(
  handles: ReadonlyMap<string, object>,
  expected: object,
  kind: Kind,
): Extract<RuntimeDefinition, Readonly<{ kind: Kind }>> {
  const definition = runtimeDefinition(expected, kind);
  const actual = handles.get(definition.type);

  if (actual !== expected) {
    throw new Error(`Unregistered ${kind}: ${definition.type}`);
  }

  return definition;
}

export function kernel<Environment extends { database: DatabaseSync }>(
  options: KernelOptions<Environment>,
) {
  const commands = index(options.commands, "command");
  const events = index(options.events, "event");
  const listeners = index(options.listeners, "listener");
  const effects = index(options.effects, "effect");
  const projectors = index(options.projectors, "projector");
  const queries = index(options.queries, "query");
  const database = options.env.database as AuthorizedDatabase;
  const projectorTables = new Set<string>();
  const internalStatementScope = Object.freeze({});
  // Scope identity prevents identical SQL from crossing authorization bounds.
  const statementsByScope = new Map<object, Map<string, PreparedStatement>>();

  function prepare(scope: object, text: string): PreparedStatement {
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

  for (const handle of projectors.values()) {
    const definition = runtimeDefinition(handle, "projector");

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
          registered(projectors, dependency, "projector").table
        ),
      );
      policy = authorizer(tables, false);
      queryAuthorizers.set(query, policy);
    }

    return policy;
  }

  const raisedEvents = new WeakMap<
    RaisedEvent,
    Readonly<{ event: Event; data: unknown }>
  >();
  const queuedEffects = new WeakMap<
    QueuedEffect,
    Readonly<{ effect: object; input: unknown }>
  >();

  const commandContext: CommandContext = Object.freeze({
    raise<Data extends ZodType>(definition: Event<Data>, data: z.input<Data>) {
      const event = registered(events, definition, "event");
      const raised = Object.freeze({}) as RaisedEvent;
      raisedEvents.set(
        raised,
        Object.freeze({
          event: definition,
          data: event.data.parse(data),
        }),
      );
      return raised;
    },
  });

  const listenerContext: ListenerContext = Object.freeze({
    queue<Input extends ZodType, EffectEnvironment>(
      definition: Effect<Input, EffectEnvironment>,
      input: z.input<Input>,
    ) {
      const effect = registered(effects, definition, "effect");
      const queued = Object.freeze({}) as QueuedEffect;
      queuedEffects.set(
        queued,
        Object.freeze({
          effect: definition,
          input: effect.input.parse(input),
        }),
      );
      return queued;
    },
  });

  async function dispatch<Input extends ZodType>(
    definition: Command<Input>,
    input: z.input<Input>,
  ): Promise<void> {
    const command = registered(commands, definition, "command");
    const raised = command.handle(commandContext, command.input.parse(input));

    if (raised === undefined) return;

    const raisedEvent = raisedEvents.get(raised);

    if (raisedEvent === undefined) {
      throw new TypeError(`Command ${command.type} returned an invalid result`);
    }

    raisedEvents.delete(raised);
    const eventHandle = raisedEvent.event;
    const event = registered(events, eventHandle, "event");
    const data = raisedEvent.data;
    const serialized = JSON.stringify(data);

    if (serialized === undefined) {
      throw new TypeError(`Event ${event.type} is not JSON serializable`);
    }

    const projectionPlans = [...projectors.values()]
      .map((handle) => runtimeDefinition(handle, "projector"))
      .flatMap((projector) =>
        projector.apply
          .filter((application) => application.on === eventHandle)
          .map((application) => ({
            projector,
            statement: application.sql(data),
          }))
      );

    const effectPlans = [...listeners.values()]
      .map((handle) => runtimeDefinition(handle, "listener"))
      .filter((listener) => listener.on === eventHandle)
      .flatMap((listener) => {
        const queued = listener.handle(listenerContext, data);

        if (queued === undefined) return [];

        const effect = queuedEffects.get(queued);

        if (effect === undefined) {
          throw new TypeError(
            `Listener ${listener.type} returned an invalid result`,
          );
        }

        queuedEffects.delete(queued);
        return [effect];
      });

    database.exec("BEGIN IMMEDIATE");

    try {
      prepare(
        internalStatementScope,
        "INSERT INTO __hyperkernel_events (type, data) VALUES (?, ?)",
      ).run(event.type, serialized);

      for (const { projector, statement } of projectionPlans) {
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

    for (const queued of effectPlans) {
      const effect = registered(effects, queued.effect, "effect");
      await effect.run(options.env, queued.input);
    }
  }

  function runQuery<Input extends ZodType, Output extends ZodType>(
    definition: Query<Input, Output>,
    input: z.input<Input>,
  ): z.output<Output> {
    const query = registered(queries, definition, "query");
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
