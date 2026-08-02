import assert from "node:assert/strict";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAuditedCrudTodoStore } from "./audited_crud_store.ts";
import { createCrudTodoStore } from "./crud_store.ts";
import { createHyperkernelTodoStore } from "./hyperkernel_store.ts";
import {
  type SqliteCallCounts,
  sqliteCallCounts,
} from "../../sqlite_instrumentation.ts";

type HyperkernelTodoStore = ReturnType<typeof createHyperkernelTodoStore>;
type TodoInput = Parameters<HyperkernelTodoStore["create"]>[0];
type Todo = Awaited<ReturnType<HyperkernelTodoStore["create"]>>;

type TodoStore = Readonly<{
  create(input: TodoInput): Promise<Todo>;
  get(id: string): Todo | null;
  list(): readonly Todo[];
  setCompleted(id: string, completed: boolean): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  stats(): BenchmarkStoreStats;
  close(): void;
}>;

type StoreFactory = (databasePath: string) => TodoStore;

export type BenchmarkLane = "crud" | "audited-crud" | "hyperkernel";

export type BenchmarkPhase =
  | "create"
  | "point-read"
  | "list-read"
  | "erase"
  | "lifecycle";

export type BenchmarkOptions = Readonly<{
  todos?: number;
  warmup?: number;
  samples?: number;
  listReads?: number;
}>;

export type BenchmarkConfig = Readonly<{
  todos: number;
  warmup: number;
  warmupTodos: number;
  samples: number;
  listReads: number;
}>;

export type BenchmarkStoreStats = Readonly<{
  journalMode: string;
  pageCount: number;
  pageSize: number;
  freelistCount: number;
  todoCount: number;
  eventCount: number;
}>;

export type DatabaseFileStats = Readonly<{
  databaseBytes: number;
  walBytes: number;
  shmBytes: number;
  totalBytes: number;
}>;

type TimedPhases = Readonly<{
  create: number;
  "point-read": number;
  "list-read": number;
  erase: number;
  lifecycle: number;
}>;

export type BenchmarkSqliteCalls = Readonly<{
  setup: SqliteCallCounts;
  create: SqliteCallCounts;
  "point-read": SqliteCallCounts;
  "list-read": SqliteCallCounts;
  erase: SqliteCallCounts;
  total: SqliteCallCounts;
}>;

export type BenchmarkSample = Readonly<{
  lane: BenchmarkLane;
  engine: string;
  sample: number;
  milliseconds: TimedPhases;
  checksum: number;
  integrityCheck: string;
  sqliteCalls: BenchmarkSqliteCalls;
  afterCreate: Readonly<{
    stats: BenchmarkStoreStats;
    files: DatabaseFileStats;
  }>;
  afterErase: Readonly<{
    stats: BenchmarkStoreStats;
    files: DatabaseFileStats;
  }>;
}>;

export type BenchmarkWorkerInput = Readonly<{
  lane: BenchmarkLane;
  todos: number;
  listReads: number;
  databasePath: string;
  sample: number;
}>;

export type BenchmarkWorkerResponse =
  | Readonly<{ ok: true; sample: BenchmarkSample }>
  | Readonly<{
    ok: false;
    error: Readonly<{ name: string; message: string; stack?: string }>;
  }>;

export type BenchmarkSummary = Readonly<{
  lane: BenchmarkLane;
  engine: string;
  phase: BenchmarkPhase;
  operations: number;
  samplesMs: readonly number[];
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  operationsPerSecondAtMedianDuration: number;
  operationsPerSecondAtP95Duration: number;
}>;

export type BenchmarkRatio = Readonly<{
  phase: BenchmarkPhase;
  hyperkernelToCrudDuration: number;
  hyperkernelToCrudThroughput: number;
  hyperkernelToAuditedCrudDuration: number;
  hyperkernelToAuditedCrudThroughput: number;
}>;

export type BenchmarkStorageSummary = Readonly<{
  lane: BenchmarkLane;
  afterCreateMedianActiveFiles: DatabaseFileStats;
  afterEraseMedianActiveFiles: DatabaseFileStats;
  afterEraseMedianNonFreelistPageBytes: number;
  afterEraseEventCount: number;
  journalModes: readonly string[];
  integrityChecks: readonly string[];
}>;

export type BenchmarkReport = Readonly<{
  schemaVersion: 1;
  generatedAt: string;
  wallTimeMs: number;
  runtime: Readonly<{
    deno: string;
    v8: string;
    typescript: string;
    sqlite: string;
    os: string;
    arch: string;
  }>;
  config: BenchmarkConfig;
  summaries: readonly BenchmarkSummary[];
  ratios: readonly BenchmarkRatio[];
  storage: readonly BenchmarkStorageSummary[];
  samples: readonly BenchmarkSample[];
}>;

type LaneDefinition = Readonly<{
  lane: BenchmarkLane;
  createStore: StoreFactory;
}>;

type Workload = Readonly<{
  fixtures: readonly TodoInput[];
  pointReadIds: readonly string[];
  expectedById: ReadonlyMap<string, TodoInput>;
}>;

const DEFAULTS = Object.freeze({
  todos: 1_000,
  warmup: 1,
  samples: 9,
  listReads: 5,
});

const PHASES: readonly BenchmarkPhase[] = Object.freeze([
  "create",
  "point-read",
  "list-read",
  "erase",
  "lifecycle",
]);

const LANES: readonly LaneDefinition[] = Object.freeze([
  Object.freeze({ lane: "crud", createStore: createCrudTodoStore }),
  Object.freeze({
    lane: "audited-crud",
    createStore: createAuditedCrudTodoStore,
  }),
  Object.freeze({
    lane: "hyperkernel",
    createStore: createHyperkernelTodoStore,
  }),
]);

const BENCHMARK_WORKER_URL = new URL("./benchmark_worker.ts", import.meta.url);

function requireInteger(
  name: string,
  value: number,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(
      `${name} must be an integer greater than or equal to ${minimum}`,
    );
  }

  return value;
}

function normalizeOptions(options: BenchmarkOptions): BenchmarkConfig {
  const todos = requireInteger("todos", options.todos ?? DEFAULTS.todos, 1);
  const warmup = requireInteger("warmup", options.warmup ?? DEFAULTS.warmup, 0);
  const samples = requireInteger(
    "samples",
    options.samples ?? DEFAULTS.samples,
    1,
  );
  const listReads = requireInteger(
    "listReads",
    options.listReads ?? DEFAULTS.listReads,
    1,
  );

  return Object.freeze({
    todos,
    warmup,
    warmupTodos: Math.min(todos, 1_000),
    samples,
    listReads,
  });
}

function createWorkload(todos: number): Workload {
  const fixtures = Array.from({ length: todos }, (_, index) => {
    const ordinal = index + 1;
    return Object.freeze({
      id: `todo-${String(ordinal).padStart(8, "0")}`,
      title: `Benchmark todo ${String(ordinal).padStart(8, "0")}`,
      createdAt: 1_700_000_000_000 + ordinal,
    }) satisfies TodoInput;
  });
  const pointReadIds = fixtures.map((fixture) => fixture.id);
  let randomState = (0x9e3779b9 ^ todos) >>> 0;

  for (let index = pointReadIds.length - 1; index > 0; index -= 1) {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    const other = randomState % (index + 1);
    [pointReadIds[index], pointReadIds[other]] = [
      pointReadIds[other],
      pointReadIds[index],
    ];
  }

  return Object.freeze({
    fixtures: Object.freeze(fixtures),
    pointReadIds: Object.freeze(pointReadIds),
    expectedById: new Map(fixtures.map((fixture) => [fixture.id, fixture])),
  });
}

async function elapsed(run: () => void | Promise<void>): Promise<number> {
  const startedAt = performance.now();
  await run();
  return Math.max(performance.now() - startedAt, 0.000_001);
}

function subtractSqliteCalls(
  after: SqliteCallCounts,
  before: SqliteCallCounts,
): SqliteCallCounts {
  return Object.freeze({
    statementPreparations: after.statementPreparations -
      before.statementPreparations,
    authorizerInstallations: after.authorizerInstallations -
      before.authorizerInstallations,
    authorizerClears: after.authorizerClears - before.authorizerClears,
  });
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await Deno.stat(path)).size;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
}

async function databaseFileStats(
  databasePath: string,
): Promise<DatabaseFileStats> {
  const [databaseBytes, walBytes, shmBytes] = await Promise.all([
    fileSize(databasePath),
    fileSize(`${databasePath}-wal`),
    fileSize(`${databasePath}-shm`),
  ]);

  return Object.freeze({
    databaseBytes,
    walBytes,
    shmBytes,
    totalBytes: databaseBytes + walBytes + shmBytes,
  });
}

function databaseIntegrity(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });

  try {
    const row = database.prepare("PRAGMA integrity_check").get() as
      | { integrity_check: string }
      | undefined;
    return row?.integrity_check ?? "missing-result";
  } finally {
    database.close();
  }
}

function sqliteVersion(): string {
  const database = new DatabaseSync(":memory:");

  try {
    const row = database.prepare("SELECT sqlite_version() AS version").get() as
      | { version: string }
      | undefined;
    return row?.version ?? "unknown";
  } finally {
    database.close();
  }
}

function verifyTodo(actual: Todo, expected: TodoInput): void {
  assert.equal(actual.id, expected.id);
  assert.equal(actual.title, expected.title);
  assert.equal(actual.completed, false);
  assert.equal(actual.createdAt, expected.createdAt);
}

function verifyPointReads(
  workload: Workload,
  todos: readonly (Todo | null)[],
): readonly Todo[] {
  assert.equal(todos.length, workload.pointReadIds.length);

  return Object.freeze(todos.map((todo, index) => {
    assert.ok(todo, `Missing point read for ${workload.pointReadIds[index]}`);
    const expected = workload.expectedById.get(todo.id);
    assert.ok(expected, `Unexpected point-read todo ${todo.id}`);
    assert.equal(todo.id, workload.pointReadIds[index]);
    verifyTodo(todo, expected);
    return todo;
  }));
}

function verifyLists(
  workload: Workload,
  lists: readonly (readonly Todo[])[],
): void {
  for (const todos of lists) {
    assert.equal(todos.length, workload.fixtures.length);
    const seen = new Set<string>();

    for (const todo of todos) {
      const expected = workload.expectedById.get(todo.id);
      assert.ok(expected, `Unexpected listed todo ${todo.id}`);
      assert.equal(
        seen.has(todo.id),
        false,
        `Duplicate listed todo ${todo.id}`,
      );
      seen.add(todo.id);
      verifyTodo(todo, expected);
    }

    assert.equal(seen.size, workload.fixtures.length);
  }
}

function checksum(todos: readonly Todo[]): number {
  let value = 2_166_136_261;

  for (const todo of todos) {
    const serialized = `${todo.id}\0${todo.title}\0${
      Number(todo.completed)
    }\0${todo.createdAt}`;

    for (let index = 0; index < serialized.length; index += 1) {
      value ^= serialized.charCodeAt(index);
      value = Math.imul(value, 16_777_619);
    }
  }

  return value >>> 0;
}

function verifyStats(
  lane: BenchmarkLane,
  todoCount: number,
  expectedEventCount: number,
  stats: BenchmarkStoreStats,
): void {
  assert.equal(stats.journalMode.toLowerCase(), "wal");
  assert.equal(stats.todoCount, todoCount);
  assert.ok(stats.pageCount > 0);
  assert.ok(stats.pageSize > 0);
  assert.ok(stats.freelistCount >= 0);

  if (lane === "crud") {
    assert.equal(stats.eventCount, 0);
  } else {
    assert.equal(stats.eventCount, expectedEventCount);
  }
}

async function runLifecycle(
  definition: LaneDefinition,
  workload: Workload,
  listReads: number,
  databasePath: string,
  sample: number,
): Promise<BenchmarkSample> {
  const beforeSetupCalls = sqliteCallCounts();
  const store = definition.createStore(databasePath);
  const afterSetupCalls = sqliteCallCounts();

  try {
    const pointResults = new Array<Todo | null>(workload.pointReadIds.length);
    const listResults = new Array<readonly Todo[]>(listReads);
    const eraseResults = new Array<boolean>(workload.fixtures.length);

    const createMs = await elapsed(async () => {
      for (const fixture of workload.fixtures) {
        await store.create(fixture);
      }
    });
    const afterCreateCalls = sqliteCallCounts();

    const afterCreateStats = store.stats();
    const afterCreateFiles = await databaseFileStats(databasePath);

    const pointReadMs = await elapsed(() => {
      for (let index = 0; index < workload.pointReadIds.length; index += 1) {
        pointResults[index] = store.get(workload.pointReadIds[index]);
      }
    });
    const afterPointReadCalls = sqliteCallCounts();

    const listReadMs = await elapsed(() => {
      for (let index = 0; index < listReads; index += 1) {
        listResults[index] = store.list();
      }
    });
    const afterListReadCalls = sqliteCallCounts();

    const eraseMs = await elapsed(async () => {
      for (let index = 0; index < workload.fixtures.length; index += 1) {
        eraseResults[index] = await store.remove(workload.fixtures[index].id);
      }
    });
    const afterEraseCalls = sqliteCallCounts();

    const afterEraseStats = store.stats();
    const afterEraseFiles = await databaseFileStats(databasePath);
    const integrityCheck = databaseIntegrity(databasePath);

    verifyStats(
      definition.lane,
      workload.fixtures.length,
      workload.fixtures.length,
      afterCreateStats,
    );
    verifyStats(
      definition.lane,
      0,
      workload.fixtures.length * 2,
      afterEraseStats,
    );
    assert.equal(integrityCheck, "ok");
    assert.equal(eraseResults.every(Boolean), true);

    const verifiedPointReads = verifyPointReads(workload, pointResults);
    verifyLists(workload, listResults);

    return Object.freeze({
      lane: definition.lane,
      engine: definition.lane,
      sample,
      milliseconds: Object.freeze({
        create: createMs,
        "point-read": pointReadMs,
        "list-read": listReadMs,
        erase: eraseMs,
        lifecycle: createMs + pointReadMs + listReadMs + eraseMs,
      }),
      checksum: checksum(verifiedPointReads),
      integrityCheck,
      sqliteCalls: Object.freeze({
        setup: subtractSqliteCalls(afterSetupCalls, beforeSetupCalls),
        create: subtractSqliteCalls(afterCreateCalls, afterSetupCalls),
        "point-read": subtractSqliteCalls(
          afterPointReadCalls,
          afterCreateCalls,
        ),
        "list-read": subtractSqliteCalls(
          afterListReadCalls,
          afterPointReadCalls,
        ),
        erase: subtractSqliteCalls(afterEraseCalls, afterListReadCalls),
        total: subtractSqliteCalls(afterEraseCalls, beforeSetupCalls),
      }),
      afterCreate: Object.freeze({
        stats: afterCreateStats,
        files: afterCreateFiles,
      }),
      afterErase: Object.freeze({
        stats: afterEraseStats,
        files: afterEraseFiles,
      }),
    });
  } finally {
    store.close();
  }
}

export function runBenchmarkSample(
  input: BenchmarkWorkerInput,
): Promise<BenchmarkSample> {
  const definition = LANES.find((candidate) => candidate.lane === input.lane);
  assert.ok(definition, `Unknown benchmark lane: ${input.lane}`);

  return runLifecycle(
    definition,
    createWorkload(input.todos),
    input.listReads,
    input.databasePath,
    input.sample,
  );
}

function runIsolatedLifecycle(
  input: BenchmarkWorkerInput,
): Promise<BenchmarkSample> {
  const worker = new Worker(BENCHMARK_WORKER_URL.href, { type: "module" });

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      run();
    };

    worker.addEventListener(
      "message",
      (event: MessageEvent<BenchmarkWorkerResponse>) => {
        const response = event.data;

        if (response.ok) {
          const sample = response.sample;
          finish(() => resolve(sample));
          return;
        }

        const cause = new Error(response.error.message);
        cause.name = response.error.name;
        if (response.error.stack !== undefined) {
          cause.stack = response.error.stack;
        }
        finish(() => reject(cause));
      },
      { once: true },
    );
    worker.addEventListener(
      "error",
      (event) => {
        event.preventDefault();
        finish(() => reject(event.error ?? new Error(event.message)));
      },
      { once: true },
    );
    worker.postMessage(input);
  });
}

function rotatedLanes(round: number): readonly LaneDefinition[] {
  const offset = round % LANES.length;
  return Object.freeze([...LANES.slice(offset), ...LANES.slice(0, offset)]);
}

function phaseOperations(
  phase: BenchmarkPhase,
  config: BenchmarkConfig,
): number {
  switch (phase) {
    case "create":
    case "point-read":
    case "erase":
      return config.todos;
    case "list-read":
      return config.listReads;
    case "lifecycle":
      return config.todos * 3 + config.listReads;
  }
}

function median(values: readonly number[]): number {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile95(values: readonly number[]): number {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function summarize(
  config: BenchmarkConfig,
  samples: readonly BenchmarkSample[],
): readonly BenchmarkSummary[] {
  return Object.freeze(LANES.flatMap(({ lane }) => {
    const laneSamples = samples
      .filter((sample) => sample.lane === lane)
      .sort((left, right) => left.sample - right.sample);
    assert.equal(laneSamples.length, config.samples);
    const engines = new Set(laneSamples.map((sample) => sample.engine));
    assert.equal(engines.size, 1);
    const engine = laneSamples[0].engine;

    return PHASES.map((phase) => {
      const samplesMs = laneSamples.map((sample) => sample.milliseconds[phase]);
      const medianMs = median(samplesMs);
      const p95Ms = percentile95(samplesMs);
      const operations = phaseOperations(phase, config);

      return Object.freeze({
        lane,
        engine,
        phase,
        operations,
        samplesMs: Object.freeze(samplesMs),
        minMs: Math.min(...samplesMs),
        medianMs,
        p95Ms,
        maxMs: Math.max(...samplesMs),
        operationsPerSecondAtMedianDuration: operations /
          (medianMs / 1_000),
        operationsPerSecondAtP95Duration: operations / (p95Ms / 1_000),
      });
    });
  }));
}

function findSummary(
  summaries: readonly BenchmarkSummary[],
  lane: BenchmarkLane,
  phase: BenchmarkPhase,
): BenchmarkSummary {
  const summary = summaries.find((candidate) =>
    candidate.lane === lane && candidate.phase === phase
  );
  assert.ok(summary);
  return summary;
}

function summarizeRatios(
  summaries: readonly BenchmarkSummary[],
): readonly BenchmarkRatio[] {
  return Object.freeze(PHASES.map((phase) => {
    const crud = findSummary(summaries, "crud", phase);
    const auditedCrud = findSummary(summaries, "audited-crud", phase);
    const hyperkernel = findSummary(summaries, "hyperkernel", phase);

    return Object.freeze({
      phase,
      hyperkernelToCrudDuration: hyperkernel.medianMs / crud.medianMs,
      hyperkernelToCrudThroughput:
        hyperkernel.operationsPerSecondAtMedianDuration /
        crud.operationsPerSecondAtMedianDuration,
      hyperkernelToAuditedCrudDuration: hyperkernel.medianMs /
        auditedCrud.medianMs,
      hyperkernelToAuditedCrudThroughput:
        hyperkernel.operationsPerSecondAtMedianDuration /
        auditedCrud.operationsPerSecondAtMedianDuration,
    });
  }));
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function medianFileStats(
  files: readonly DatabaseFileStats[],
): DatabaseFileStats {
  assert.ok(files.length > 0);
  const databaseBytes = median(files.map((entry) => entry.databaseBytes));
  const walBytes = median(files.map((entry) => entry.walBytes));
  const shmBytes = median(files.map((entry) => entry.shmBytes));

  return Object.freeze({
    databaseBytes,
    walBytes,
    shmBytes,
    totalBytes: databaseBytes + walBytes + shmBytes,
  });
}

function summarizeStorage(
  samples: readonly BenchmarkSample[],
): readonly BenchmarkStorageSummary[] {
  return Object.freeze(LANES.map(({ lane }) => {
    const laneSamples = samples.filter((sample) => sample.lane === lane);
    assert.ok(laneSamples.length > 0);
    const eventCounts = laneSamples.map((sample) =>
      sample.afterErase.stats.eventCount
    );

    return Object.freeze({
      lane,
      afterCreateMedianActiveFiles: medianFileStats(
        laneSamples.map((sample) => sample.afterCreate.files),
      ),
      afterEraseMedianActiveFiles: medianFileStats(
        laneSamples.map((sample) => sample.afterErase.files),
      ),
      afterEraseMedianNonFreelistPageBytes: median(
        laneSamples.map((sample) => {
          const stats = sample.afterErase.stats;
          return (stats.pageCount - stats.freelistCount) * stats.pageSize;
        }),
      ),
      afterEraseEventCount: median(eventCounts),
      journalModes: uniqueSorted(
        laneSamples.map((sample) => sample.afterErase.stats.journalMode),
      ),
      integrityChecks: uniqueSorted(
        laneSamples.map((sample) => sample.integrityCheck),
      ),
    });
  }));
}

export async function runBenchmark(
  options: BenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const config = normalizeOptions(options);
  const samples: BenchmarkSample[] = [];
  const startedAt = performance.now();
  const tempDirectory = await Deno.makeTempDir({
    dir: import.meta.dirname,
    prefix: ".todo-benchmark-",
  });

  try {
    for (let warmup = 0; warmup < config.warmup; warmup += 1) {
      for (const definition of rotatedLanes(warmup)) {
        await runIsolatedLifecycle({
          lane: definition.lane,
          todos: config.warmupTodos,
          listReads: config.listReads,
          databasePath: join(
            tempDirectory,
            `warmup-${warmup}-${definition.lane}.sqlite`,
          ),
          sample: warmup,
        });
      }
    }

    for (let sample = 0; sample < config.samples; sample += 1) {
      for (const definition of rotatedLanes(sample)) {
        samples.push(
          await runIsolatedLifecycle({
            lane: definition.lane,
            todos: config.todos,
            listReads: config.listReads,
            databasePath: join(
              tempDirectory,
              `sample-${sample}-${definition.lane}.sqlite`,
            ),
            sample,
          }),
        );
      }
    }
  } finally {
    await Deno.remove(tempDirectory, { recursive: true });
  }

  const summaries = summarize(config, samples);

  return Object.freeze({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    wallTimeMs: performance.now() - startedAt,
    runtime: Object.freeze({
      deno: Deno.version.deno,
      v8: Deno.version.v8,
      typescript: Deno.version.typescript,
      sqlite: sqliteVersion(),
      os: Deno.build.os,
      arch: Deno.build.arch,
    }),
    config,
    summaries,
    ratios: summarizeRatios(summaries),
    storage: summarizeStorage(samples),
    samples: Object.freeze(samples),
  });
}

function parseIntegerArgument(name: string, value: string): number {
  if (value.length === 0) throw new TypeError(`--${name} requires a value`);
  return requireInteger(name, Number(value), name === "warmup" ? 0 : 1);
}

function parseArguments(args: readonly string[]): Readonly<{
  options: BenchmarkOptions;
  jsonPath: string | undefined;
  help: boolean;
}> {
  const options: {
    todos?: number;
    warmup?: number;
    samples?: number;
    listReads?: number;
  } = {};
  let jsonPath: string | undefined;
  let help = false;

  for (const argument of args) {
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const value = separator === -1 ? "" : argument.slice(separator + 1);

    switch (name) {
      case "--todos":
        options.todos = parseIntegerArgument("todos", value);
        break;
      case "--warmup":
        options.warmup = parseIntegerArgument("warmup", value);
        break;
      case "--samples":
        options.samples = parseIntegerArgument("samples", value);
        break;
      case "--list-reads":
        options.listReads = parseIntegerArgument("list-reads", value);
        break;
      case "--json":
        if (value.length === 0) throw new TypeError("--json requires a path");
        jsonPath = value;
        break;
      case "--help":
      case "-h":
        if (separator !== -1) {
          throw new TypeError(`${name} does not take a value`);
        }
        help = true;
        break;
      default:
        throw new TypeError(`Unknown argument: ${argument}`);
    }
  }

  return Object.freeze({ options: Object.freeze(options), jsonPath, help });
}

function fixed(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : String(value);
}

function resolveJsonOutputPath(path: string): string {
  const absolutePath = resolve(path);
  const experimentDirectory = import.meta.dirname;
  assert.ok(experimentDirectory);
  const pathWithinExperiment = relative(experimentDirectory, absolutePath);

  if (
    pathWithinExperiment.length === 0 || pathWithinExperiment === ".." ||
    pathWithinExperiment.startsWith(`..${sep}`) ||
    isAbsolute(pathWithinExperiment)
  ) {
    throw new TypeError(
      "--json must name a file inside experiments/todo-comparison",
    );
  }

  return absolutePath;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${fixed(bytes, 0)} B`;
  if (bytes < 1_048_576) return `${fixed(bytes / 1_024, 1)} KiB`;
  return `${fixed(bytes / 1_048_576, 1)} MiB`;
}

function formatReport(report: BenchmarkReport): string {
  const showsP95 = report.config.samples >= 20;
  const tailLabel = showsP95 ? "p95 ms" : "max ms";
  const lines = [
    `Todo comparison: ${report.config.todos} todos, ${report.config.samples} samples, ${report.config.warmup} warmup`,
    `Deno ${report.runtime.deno}; SQLite ${report.runtime.sqlite}; ${report.runtime.os}/${report.runtime.arch}`,
    "",
    `| phase | lane | median ms | ${tailLabel} | ops/s at median |`,
    "| --- | --- | ---: | ---: | ---: |",
  ];

  for (const phase of PHASES) {
    for (const { lane } of LANES) {
      const summary = findSummary(report.summaries, lane, phase);
      lines.push(
        `| ${phase} | ${lane} | ${fixed(summary.medianMs)} | ${
          fixed(showsP95 ? summary.p95Ms : summary.maxMs)
        } | ${fixed(summary.operationsPerSecondAtMedianDuration, 0)} |`,
      );
    }
  }

  lines.push(
    "",
    "| phase | HK/CRUD time | HK/CRUD throughput | HK/audited time | HK/audited throughput |",
    "| --- | ---: | ---: | ---: | ---: |",
  );

  for (const ratio of report.ratios) {
    lines.push(
      `| ${ratio.phase} | ${fixed(ratio.hyperkernelToCrudDuration)}x | ${
        fixed(ratio.hyperkernelToCrudThroughput)
      }x | ${fixed(ratio.hyperkernelToAuditedCrudDuration)}x | ${
        fixed(ratio.hyperkernelToAuditedCrudThroughput)
      }x |`,
    );
  }

  lines.push(
    "",
    "Active SQLite files (open connection; WAL allocation is not retained database size):",
    "",
    "| stage | lane | main DB | WAL | SHM | total |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  );

  for (const storage of report.storage) {
    for (
      const [stage, files] of [
        ["after create", storage.afterCreateMedianActiveFiles],
        ["after erase", storage.afterEraseMedianActiveFiles],
      ] as const
    ) {
      lines.push(
        `| ${stage} | ${storage.lane} | ${formatBytes(files.databaseBytes)} | ${
          formatBytes(files.walBytes)
        } | ${formatBytes(files.shmBytes)} | ${
          formatBytes(files.totalBytes)
        } |`,
      );
    }
  }

  lines.push(
    "",
    "| lane | estimated non-freelist page bytes after erase | events after erase | journal | integrity |",
    "| --- | ---: | ---: | --- | --- |",
  );

  for (const storage of report.storage) {
    lines.push(
      `| ${storage.lane} | ${
        formatBytes(storage.afterEraseMedianNonFreelistPageBytes)
      } | ${storage.afterEraseEventCount ?? "n/a"} | ${
        storage.journalModes.join(", ")
      } | ${storage.integrityChecks.join(", ")} |`,
    );
  }

  const hyperkernelSample = report.samples.find((sample) =>
    sample.lane === "hyperkernel"
  );
  assert.ok(hyperkernelSample);
  lines.push(
    "",
    "Hyperkernel SQLite calls per sample:",
    "",
    "| phase | statement preparations | authorizer installations | authorizer clears |",
    "| --- | ---: | ---: | ---: |",
  );

  for (
    const phase of [
      "setup",
      "create",
      "point-read",
      "list-read",
      "erase",
      "total",
    ] as const
  ) {
    const counts = hyperkernelSample.sqliteCalls[phase];
    lines.push(
      `| ${phase} | ${counts.statementPreparations} | ${counts.authorizerInstallations} | ${counts.authorizerClears} |`,
    );
  }

  return lines.join("\n");
}

const USAGE = `Usage:
  deno task todo:bench [options]

Options:
  --todos=<count>       Todos per measured lifecycle (default: ${DEFAULTS.todos})
  --warmup=<count>      Warmup rounds per lane (default: ${DEFAULTS.warmup})
  --samples=<count>     Measured rounds per lane (default: ${DEFAULTS.samples})
  --list-reads=<count>  Full-list reads per lifecycle (default: ${DEFAULTS.listReads})
  --json=<path>         Write JSON inside experiments/todo-comparison
  -h, --help            Show this help`;

async function main(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);

  if (parsed.help) {
    console.log(USAGE);
    return;
  }

  const jsonOutputPath = parsed.jsonPath === undefined
    ? undefined
    : resolveJsonOutputPath(parsed.jsonPath);
  const report = await runBenchmark(parsed.options);
  console.log(formatReport(report));

  if (jsonOutputPath !== undefined) {
    await Deno.writeTextFile(
      jsonOutputPath,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(`\nJSON report: ${parsed.jsonPath}`);
  }
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(
      error instanceof Error ? error.stack ?? error.message : error,
    );
    Deno.exitCode = 1;
  }
}
