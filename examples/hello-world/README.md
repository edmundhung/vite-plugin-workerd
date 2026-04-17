# Hello World

The basic setup: one worker, one `workerd.config.ts`, and a single `fetch()` response.

To test:

```sh
pnpm --filter hello-world-example build
workerd serve examples/hello-world/dist/workerd.capnp
```

Example request:

```sh
curl "http://127.0.0.1:8787/"
```
