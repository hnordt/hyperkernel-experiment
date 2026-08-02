# Benchmark results

Recorded on 2026-08-01 with Deno 2.9.4, SQLite 3.53.2, macOS on Apple Silicon.
These numbers are a reproducible local baseline, not portable performance
guarantees.

Each lane/sample ran in a dedicated worker isolate against a fresh file-backed
database. Worker startup, fixture generation, migrations, verification,
reporting, and cleanup were outside the timed phases. Every integrity check
returned `ok`, and every store reported `journal_mode=wal`.

Warmup lifecycles ran in separate isolates. They warmed shared module and
filesystem caches without carrying a closed database's native runtime resources
into a measured sample; they did not pre-JIT the measured worker. These are
cold-isolate lifecycle results, not steady-state results from one already-warmed
worker.

Nine measured samples give every lane each first/second/third execution position
three times. Because nine samples are too few for a useful p95 estimate, the CLI
reported the maximum beside each median.

## 1,000-Todo lifecycle

Configuration: one warmup, nine measured samples, five complete list reads per
sample.

| Phase      | CRUD median | Audited CRUD median | Hyperkernel median | HK / CRUD time | HK / audited time |
| ---------- | ----------: | ------------------: | -----------------: | -------------: | ----------------: |
| Create     |    28.90 ms |            38.77 ms |           68.35 ms |          2.37x |             1.76x |
| Point read |     6.00 ms |             6.20 ms |           47.04 ms |          7.84x |             7.58x |
| List read  |     9.20 ms |             9.05 ms |            9.73 ms |          1.06x |             1.08x |
| Erase      |    19.66 ms |            31.02 ms |          171.42 ms |          8.72x |             5.53x |
| Lifecycle  |    64.86 ms |            84.70 ms |          296.07 ms |          4.56x |             3.50x |

Hyperkernel median rates were 14,631 creates/s, 21,257 point reads/s, 514
complete list queries/s, and 5,834 erases/s. Its maximum measured lifecycle was
306.83 ms. The five list queries each returned all 1,000 Todos.

After all Todos were erased, CRUD had no retained events and an estimated 12 KiB
of non-freelist page bytes. Hyperkernel and audited CRUD each retained 2,000
events and an estimated 180 KiB of non-freelist page bytes.

## 10,000-Todo lifecycle

Configuration: one warmup, nine measured samples, three complete list reads per
sample.

| Phase      | CRUD median | Audited CRUD median | Hyperkernel median | HK / CRUD time | HK / audited time |
| ---------- | ----------: | ------------------: | -----------------: | -------------: | ----------------: |
| Create     |   219.55 ms |           326.00 ms |        1,721.61 ms |          7.84x |             5.28x |
| Point read |    51.61 ms |            51.91 ms |        2,608.53 ms |         50.54x |            50.25x |
| List read  |    48.67 ms |            48.36 ms |           82.97 ms |          1.70x |             1.72x |
| Erase      |   194.30 ms |           293.64 ms |        4,740.09 ms |         24.40x |            16.14x |
| Lifecycle  |   518.39 ms |           722.43 ms |        9,147.53 ms |         17.65x |            12.66x |

Hyperkernel median rates were 5,809 creates/s, 3,834 point reads/s, 36 complete
list queries/s, and 2,110 erases/s. Its maximum measured lifecycle was 9,240.26
ms. The three list queries each returned all 10,000 Todos.

After erasure, Hyperkernel and audited CRUD both retained 20,000 events in the
same event-table representation and had an estimated 1.6 MiB of non-freelist
page bytes; CRUD retained no events and an estimated 12 KiB. A separate contract
test verifies equivalent ordered histories for the canonical mutation sequence.
The matching event counts and storage but very different timings show that event
retention is not the main source of the Hyperkernel gap.

## Conclusion

For this workload, the current Hyperkernel is competitive only on amortized
full-list reads. It does not yet match traditional CRUD for per-item reads or
writes, and the gap widens as one lifecycle grows from 1,000 to 10,000 Todos.

Audited CRUD pays the same two-write/event-retention feature cost but remains
near the CRUD baseline. The implementation and scaling curve therefore point to
current per-operation kernel work—especially repeated statement preparation and
SQLite authorizer installation around each query/projector—as the first
optimization target. That is an inference to validate with a profiler, not a
claim that the benchmark alone proves one internal cause.

Erase also includes Hyperkernel's projection pre-read so `TodoDeleted` is never
recorded for a missing Todo. Audited CRUD performs the same factual-event check,
which is why its much lower erase time is the relevant control.

The decision boundary is workload latency, not ratio alone. The 1,000-Todo
absolute rates may already be sufficient for a small single-writer application
that values audit history and replay. The 10,000-Todo curve says the current
kernel needs statement/authorization lifecycle work before claiming CRUD-like
task throughput at larger histories.
