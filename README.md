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

const api = createWorker("./src/auth.js", {
	compatibilityDate: "2026-01-01",
	exports: {
		Auth: workerEntrypoint<{ baseURL: string }>(),
	},
});

const app = createWorker("./src/api.js", {
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
