# vite-plugin-workerd

A Vite plugin for authoring and building workerd config

## Install

```bash
npm install vite-plugin-workerd --save-dev
```

## Usage

`workerd.config.ts`

```ts
import {
	createWorker,
	defineConfig,
	workerEntrypoint,
} from "vite-plugin-workerd";

const api = createWorker({
	entry: new URL("./src/auth.js", import.meta.url),
	compatibilityDate: "2026-01-01",
	exports: {
		Auth: workerEntrypoint<{ baseURL: string }>(),
	},
});

const app = createWorker({
	entry: new URL("./src/api.js", import.meta.url),
	compatibilityDate: "2026-01-01",
	bindings: {
		AUTH: api.exports.Auth({
			props: { baseURL: "https://example.com" },
		}),
	},
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

Use `entry: new URL("./worker.ts", import.meta.url)` or an absolute path when calling `createWorker()`. Relative string entries are rejected so helper-defined workers stay anchored to the module that declared them.

`vite.config.ts`

```ts
import { defineConfig } from "vite";
import { workerd } from "vite-plugin-workerd";

export default defineConfig({
	plugins: [workerd()],
});
```

Then run:

```sh
npx vite build
workerd serve dist/workerd.capnp
```

## Examples

- `examples/hello-world`: the smallest single-worker example
- `examples/bundling`: a single worker that imports and uses an npm dependency
- `examples/multi-workers`: a larger setup with multiple workers, bindings, typed RPC, and split TypeScript configs

Example output:

```capnp
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
      (
        name = "worker1",
        worker = .worker1,
      ),
      (
        name = "worker:2",
        worker = .worker2,
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
  bindings = [
      (
        name = "AUTH",
        service = (
            name = "worker:2",
            entrypoint = "Auth",
            props = ( json = "{\"baseURL\":\"https://example.com\"}" ),
          ),
      ),
    ],
);

const worker2 :Workerd.Worker = (
  modules = [
      (
        name = "main",
        esModule = embed "workers/worker2.js",
      ),
    ],
  compatibilityDate = "2026-01-01",
);
```
