# vite-plugin-workerd

A Vite plugin for authoring and building workerd config

## Install

```bash
npm install --save-dev vite-plugin-workerd workerd @cloudflare/workers-types
```

## Get Started

To start, add a `workerd.config.ts` file in the project root. This is where you define your workers and the sockets that expose them. You can think of this file as a JS representation of a `workerd` config. Helpers like `createWorker()` make individual pieces easier to author, and `defineConfig()` combines them into the final config object.

```ts
import {
	createWorker,
	defineConfig,
} from "vite-plugin-workerd";

const app = createWorker({
	entry: new URL("./src/app.ts", import.meta.url),
	compatibilityDate: "2026-01-01",
});

export default defineConfig({
	sockets: [
		app.listen({
			name: "app",
			address: "*:8787",
			protocol: "http",
		}),
	],
});
```

Next, add the `workerd` plugin to your Vite config. By default it looks for `workerd.config.ts` in the project root, but you can also point it at a custom config path or inline the config directly.

`vite.config.ts`

```ts
import { defineConfig } from "vite";
import { workerd } from "vite-plugin-workerd";

export default defineConfig({
	plugins: [workerd()],
});
```

For a production build, run:

```sh
vite build
workerd serve dist/workerd.capnp
```

This bundles your workers and writes a `dist/workerd.capnp` file alongside the built worker modules. The generated `workerd.capnp` is plain text, so you can inspect it directly if you want to see the final config.

For example, the config above produces something like:

```capnp
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
      (
        name = "worker1",
        worker = .worker1,
      ),
    ],
  sockets = [
      (
        name = "app",
        address = "*:8787",
        service = "worker1",
        http = (),
      ),
    ],
);

const worker1 :Workerd.Worker = (
  modules = [
      (
        name = "main",
        esModule = embed "workers/worker1.js",
      ),
    ],
  compatibilityDate = "2026-01-01",
);
```

For local development, run:

```sh
vite dev
```

This starts Vite in front of a real `workerd` process and proxies requests to it, so normal edits hot reload without manually restarting `workerd`.

## Status

> [!caution]
> This plugin is in early development and the API is likely to change.

Config authoring:

- [x] Author `workerd` config in JS/TS (`workerd.config.{js,ts}`)
- [x] Type-safe service bindings and props
- [x] Env inference from bindings
- [ ] Support modules other than ES modules
- [ ] `workerd.capnp` as an input format

Build (`vite build`):

- [x] Generate `workerd.capnp` and bundled worker chunks
- [x] Bundle npm dependencies and lazy-loaded `import()` chunks
- [x] Multi-worker builds
- [ ] Example Docker image

Dev (`vite dev`):

- [x] Multi-worker apps
- [x] Support `ctx.exports`
- [x] Hot reload for worker code changes
- [ ] Durable Objects
- [ ] WebSockets Connections
- [ ] Restart workerd on service graph changes
- [ ] Broader framework and Vite plugin compatibility

## Examples

You can find more examples in the [examples](./examples) directory:

- [Hello World](./examples/hello-world): one worker written in TypeScript with a simple `fetch()` handler.
- [Bundling](./examples/bundling): shows how npm dependencies and dynamic imports `await import(...)` are bundled in the build output.
- [Multi Workers](./examples/multi-workers): multiple workers, service bindings, and typed RPC.
