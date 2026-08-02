import assert from "node:assert/strict";
import { runBenchmark } from "./benchmark.ts";

Deno.test("benchmark smoke run verifies every lane without performance thresholds", async () => {
  const report = await runBenchmark({
    todos: 10,
    warmup: 1,
    samples: 2,
    listReads: 2,
  });

  assert.deepEqual(report.config, {
    todos: 10,
    warmup: 1,
    warmupTodos: 10,
    samples: 2,
    listReads: 2,
  });
  assert.equal(report.samples.length, 6);
  assert.equal(report.summaries.length, 15);
  assert.equal(report.ratios.length, 5);

  for (const sample of report.samples) {
    assert.equal(sample.integrityCheck, "ok");
    assert.equal(sample.afterCreate.stats.journalMode, "wal");
    assert.equal(sample.afterCreate.stats.todoCount, 10);
    assert.equal(sample.afterErase.stats.todoCount, 0);
    assert.ok(Number.isFinite(sample.milliseconds.lifecycle));
    assert.ok(sample.milliseconds.lifecycle > 0);

    const expectedEvents = sample.lane === "crud" ? 0 : 20;
    assert.equal(sample.afterErase.stats.eventCount, expectedEvents);

    const expectedSqliteCalls = sample.lane === "hyperkernel"
      ? {
        statementPreparations: 5,
        authorizerInstallations: 1,
        authorizerClears: 0,
      }
      : {
        statementPreparations: 0,
        authorizerInstallations: 0,
        authorizerClears: 0,
      };
    assert.deepEqual(sample.sqliteCalls.total, expectedSqliteCalls);
  }

  for (const summary of report.summaries) {
    assert.ok(Number.isFinite(summary.medianMs));
    assert.ok(summary.medianMs > 0);
    assert.ok(summary.minMs <= summary.medianMs);
    assert.ok(summary.medianMs <= summary.maxMs);
    assert.equal(summary.p95Ms, summary.maxMs);
    assert.ok(
      Number.isFinite(summary.operationsPerSecondAtMedianDuration),
    );
    assert.ok(summary.operationsPerSecondAtMedianDuration > 0);

    const expectedOperations = summary.phase === "list-read"
      ? 2
      : summary.phase === "lifecycle"
      ? 32
      : 10;
    assert.equal(summary.operations, expectedOperations);
    assert.equal(
      summary.operationsPerSecondAtMedianDuration,
      expectedOperations / (summary.medianMs / 1_000),
    );
  }

  for (const ratio of report.ratios) {
    assert.ok(
      Math.abs(
        ratio.hyperkernelToCrudDuration *
            ratio.hyperkernelToCrudThroughput -
          1,
      ) < 1e-12,
    );
    assert.ok(
      Math.abs(
        ratio.hyperkernelToAuditedCrudDuration *
            ratio.hyperkernelToAuditedCrudThroughput -
          1,
      ) < 1e-12,
    );
  }

  for (const storage of report.storage) {
    for (
      const files of [
        storage.afterCreateMedianActiveFiles,
        storage.afterEraseMedianActiveFiles,
      ]
    ) {
      assert.ok(files.databaseBytes > 0);
      assert.ok(files.walBytes > 0);
      assert.ok(files.shmBytes > 0);
      assert.equal(
        files.totalBytes,
        files.databaseBytes + files.walBytes + files.shmBytes,
      );
    }

    assert.ok(storage.afterEraseMedianNonFreelistPageBytes > 0);
    assert.equal(
      storage.afterEraseEventCount,
      storage.lane === "crud" ? 0 : 20,
    );
  }
});
