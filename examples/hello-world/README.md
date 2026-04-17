# Hello World

The basic setup: one worker, one `workerd.config.ts`, and a single `fetch()` response.

## How to test

1. Look at [`workerd.config.ts`](./workerd.config.ts) and [`src/worker.ts`](./src/worker.ts).
2. Build the example:

```sh
pnpm --filter hello-world-example build
```

3. Inspect `dist/workerd.capnp`. Notice there is just one service, one socket, and one `main` module entry pointing at `workers/worker1.js`.
4. Inspect `dist/workers/worker1.js`. Notice how the tiny `fetch()` handler has been bundled into the worker chunk.
5. Serve it:

```sh
workerd serve examples/hello-world/dist/workerd.capnp
```

6. Try:

```sh
curl "http://127.0.0.1:8787/"
```
