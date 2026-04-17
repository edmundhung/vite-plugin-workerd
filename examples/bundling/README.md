# Bundling

Shows how Vite bundles both a normal npm import (`semver`) and a lazily loaded module via `await import(...)` into a worker.

To test:

```sh
pnpm --filter bundling-example build
workerd serve examples/bundling/dist/workerd.capnp
```

Example requests:

```sh
curl "http://127.0.0.1:8787/?version=v1.2.3&satisfies=^1.0.0"
curl "http://127.0.0.1:8787/lazy?name=Ada"
curl "http://127.0.0.1:8787/?version=not-a-version&satisfies=^1.0.0"
```
