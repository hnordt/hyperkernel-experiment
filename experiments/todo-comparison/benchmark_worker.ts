import {
  type BenchmarkWorkerInput,
  type BenchmarkWorkerResponse,
  runBenchmarkSample,
} from "./benchmark.ts";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<BenchmarkWorkerInput>) => void) | null;
  postMessage(message: BenchmarkWorkerResponse): void;
};

workerScope.onmessage = (event) => {
  void respond(event.data);
};

async function respond(input: BenchmarkWorkerInput): Promise<void> {
  let response: BenchmarkWorkerResponse;

  try {
    response = Object.freeze({
      ok: true,
      sample: await runBenchmarkSample(input),
    });
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    response = Object.freeze({
      ok: false,
      error: Object.freeze({
        name: cause.name,
        message: cause.message,
        stack: cause.stack,
      }),
    });
  }

  workerScope.postMessage(response);
}
