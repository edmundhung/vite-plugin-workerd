import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDisk, createWorker, defineConfig, durableObject, embed } from "../src/index";
import { prepareConfigForSerialization, serializeConfig } from "../src/serialize";
import type { WorkerdConfig } from "../src/workerd";

describe("serializeConfig", () => {
	it("emits workerd text config with embedded source paths", () => {
		const root = "/virtual/project";
		const storage = createDisk({ path: "./.data/do", writable: true });
		const app = createWorker("./src/index.ts", {
			compatibilityDate: "2025-08-01",
			durableObjectStorage: { disk: storage },
			exports: {
				Counter: durableObject(),
			},
		});

		const config = defineConfig({
			sockets: [
				app.listen({
					name: "app",
					address: "*:8787",
					protocol: "http",
				}),
			],
		});

		const model = prepareConfigForSerialization(config, {
			configPath: path.join(root, "workerd.config.ts"),
			outputPath: path.join(root, "dist", "workerd.capnp"),
		});
		const serialized = serializeConfig(model);

		expect(serialized.trimEnd().split("\n")).toMatchInlineSnapshot(`
			[
			  "using Workerd = import "/workerd/workerd.capnp";",
			  "",
			  "const config :Workerd.Config = (",
			  "  services = [",
			  "      (",
			  "        name = "worker:1",",
			  "        worker = .worker1,",
			  "      ),",
			  "      (",
			  "        name = "disk:1",",
			  "        disk = (",
			  "            path = "./.data/do",",
			  "            writable = true,",
			  "          ),",
			  "      ),",
			  "    ],",
			  "  sockets = [",
			  "      (",
			  "        name = "app",",
			  "        address = "*:8787",",
			  "        service = "worker:1",",
			  "        http = (),",
			  "      ),",
			  "    ],",
			  ");",
			  "",
			  "const worker1 :Workerd.Worker = (",
			  "  modules = [",
			  "      (",
			  "        name = "main",",
			  "        esModule = embed "../src/index.ts",",
			  "      ),",
			  "    ],",
			  "  compatibilityDate = "2025-08-01",",
			  "  durableObjectNamespaces = [",
			  "      (",
			  "        className = "Counter",",
			  "        uniqueKey = "do:worker:1:Counter",",
			  "      ),",
			  "    ],",
			  "  durableObjectStorage = ( localDisk = "disk:1" ),",
			  ");",
			]
		`);
	});

	it("passes through manual raw config fields while still resolving source-backed modules", () => {
		const root = "/virtual/project";
		const config: WorkerdConfig = {
			services: [
				{
					name: "app",
					worker: {
						modules: [{ name: "main", esModule: embed("./src/index.js") }],
						compatibilityDate: "2025-08-01",
						bindings: [
							{
								name: "SELF",
								service: {
									name: "app",
									props: {
										json: '{"ok":true}',
									},
								},
							},
						],
						globalOutbound: "network",
						cacheApiOutbound: {
							name: "origin",
							props: {
								json: '{"cache":true}',
							},
						},
					},
				},
				{
					name: "network",
					network: {
						allow: ["public"],
						deny: ["private"],
					},
				},
				{
					name: "origin",
					external: {
						address: "example.com:443",
						tcp: {
							certificateHost: "example.com",
						},
					},
				},
			],
			sockets: [{ name: "app", address: "*:8787", http: {}, service: "app" }],
			structuredLogging: true,
		};

		const model = prepareConfigForSerialization(config, {
			configPath: path.join(root, "workerd.config.ts"),
			outputPath: path.join(root, "dist", "workerd.capnp"),
		});
		const serialized = serializeConfig(model);

		expect(serialized.trimEnd().split("\n")).toMatchInlineSnapshot(`
			[
			  "using Workerd = import "/workerd/workerd.capnp";",
			  "",
			  "const config :Workerd.Config = (",
			  "  services = [",
			  "      (",
			  "        name = "app",",
			  "        worker = .worker1,",
			  "      ),",
			  "      (",
			  "        name = "network",",
			  "        network = (",
			  "            allow = [ "public" ],",
			  "            deny = [ "private" ],",
			  "          ),",
			  "      ),",
			  "      (",
			  "        name = "origin",",
			  "        external = (",
			  "            address = "example.com:443",",
			  "            tcp = ( certificateHost = "example.com" ),",
			  "          ),",
			  "      ),",
			  "    ],",
			  "  sockets = [",
			  "      (",
			  "        name = "app",",
			  "        address = "*:8787",",
			  "        http = (),",
			  "        service = "app",",
			  "      ),",
			  "    ],",
			  "  structuredLogging = true,",
			  ");",
			  "",
			  "const worker1 :Workerd.Worker = (",
			  "  modules = [",
			  "      (",
			  "        name = "main",",
			  "        esModule = embed "../src/index.js",",
			  "      ),",
			  "    ],",
			  "  compatibilityDate = "2025-08-01",",
			  "  bindings = [",
			  "      (",
			  "        name = "SELF",",
			  "        service = (",
			  "            name = "app",",
			  "            props = ( json = "{\\"ok\\":true}" ),",
			  "          ),",
			  "      ),",
			  "    ],",
			  "  globalOutbound = "network",",
			  "  cacheApiOutbound = (",
			  "      name = "origin",",
			  "      props = ( json = "{\\"cache\\":true}" ),",
			  "    ),",
			  ");",
			]
		`);
	});
});
