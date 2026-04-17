# Multi Workers

This is the more advanced setup: multiple workers, typed service bindings, RPC, with type inference across workers.

## How to test

1. Look at [`workers/greet/index.ts`](./workers/greet/index.ts) and [`workers/greet/worker.ts`](./workers/greet/worker.ts).
2. Then look at [`workers/app/index.ts`](./workers/app/index.ts) and [`workers/app/worker.ts`](./workers/app/worker.ts).
3. If you want to understand the TS setup, look at [`tsconfig.node.json`](./tsconfig.node.json) and [`tsconfig.worker.json`](./tsconfig.worker.json).
4. Build the example:

```sh
pnpm --filter multi-workers-example build
```

5. Inspect `dist/workerd.capnp`. Notice the two generated services and the `GREET` service binding from `worker1` to `worker2`.
6. Inspect `dist/workers/worker1.js`. Look for the app worker logic that calls the binding over RPC and over `fetch()`.
7. Inspect `dist/workers/worker2.js`. Look for the greet worker entrypoint that backs that binding.
8. Serve it:

```sh
workerd serve examples/multi-workers/dist/workerd.capnp
```

9. Try:

```sh
curl "http://127.0.0.1:8787/greet?name=Ada"
curl "http://127.0.0.1:8787/greet-fetch?name=Lin"
```
