# vite-plugin-workerd

A Vite plugin for authoring and building workerd config

## Install

```bash
npm install vite-plugin-workerd --save-dev
```

## Get Started

Start by creating a `workerd.config.ts` file. This is the config the Vite plugin will use to build and run your workers, and it is meant to closely resemble a normal `workerd` config. `defineConfig()` returns that config shape, while helpers like `createWorker()` make it easier to author with type safety and better inference.

```ts
import {
	createWorker,
	defineConfig,
} from "vite-plugin-workerd";

const app = createWorker({
	entry: new URL("./src/app.js", import.meta.url),
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

## Examples

You can find more examples in the [examples](./examples) directory:

- [Hello World](./examples/hello-world): one worker with a single `fetch()` handler.
- [Bundling](./examples/bundling): shows how npm dependencies and dynamic imports `await import(...)` are bundled in the build output.
- [Multi Workers](./examples/multi-workers): demonstrate multiple workers, JSRPC with type inference.
