# Multi Workers

This is the more advanced setup: multiple workers, typed service bindings, RPC, with type inference across workers.

To test:

```sh
pnpm --filter multi-workers-example build
workerd serve examples/multi-workers/dist/workerd.capnp
```

Example requests:

```sh
curl "http://127.0.0.1:8787/greet?name=Ada"
curl "http://127.0.0.1:8787/greet-fetch?name=Lin"
```
