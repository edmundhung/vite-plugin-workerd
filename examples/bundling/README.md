# Bundling

Shows how Vite bundles both a normal npm import (`semver`) and a lazily loaded module via `await import(...)` into a worker.

## How to test

1. Look at [`src/worker.ts`](./src/worker.ts), [`src/lazy.ts`](./src/lazy.ts), and [`workerd.config.ts`](./workerd.config.ts).
2. Build the example:

```sh
pnpm --filter bundling-example build
```

3. Inspect `dist/workerd.capnp`. Notice the extra module entry for the lazily loaded chunk.
4. Inspect `dist/workers/worker1.js`. Look for the statically bundled `semver` path and the dynamic `import("./lazy")` boundary.
5. Inspect `dist/workers/worker1-lazy-*.js`. This is the lazily loaded module split into its own chunk.
6. Serve it:

```sh
workerd serve examples/bundling/dist/workerd.capnp
```

7. Try:

```sh
curl "http://127.0.0.1:8787/?version=v1.2.3&satisfies=^1.0.0"
curl "http://127.0.0.1:8787/lazy?name=Ada"
curl "http://127.0.0.1:8787/?version=not-a-version&satisfies=^1.0.0"
```
