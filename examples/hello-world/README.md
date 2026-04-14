# Hello World

To test:

```sh
pnpm --filter hello-world-example build
workerd serve examples/hello-world/dist/workerd.capnp
```

Example requests:

```sh
curl "http://127.0.0.1:8787/semver?satisfies=^7.0.0"
curl "http://127.0.0.1:8787/vite-plugin-workerd?satisfies=^0.0.1"
```
