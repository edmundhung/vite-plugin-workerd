import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDisk, createWorker, defineConfig, durableObject, embed } from "../src/index";
import { getEmbeddedPath, isEmbeddedPath } from "../src/config/syntax";
import { prepareConfigForSerialization, serializeConfig } from "../src/config/serialize";
import type { WorkerdConfig } from "../src/config/workerd";

describe("serializeConfig", () => {
	it("emits workerd text config with embedded source paths", () => {
		const root = "/virtual/project";
		const storage = createDisk({ path: "./.data/do", writable: true });
		const app = createWorker({
			entry: path.join(root, "src", "index.ts"),
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

		const model = prepareConfigForSerialization(normalizeEmbeddedPaths(config, root), {
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
			  "        name = "worker1",",
			  "        worker = .worker1,",
			  "      ),",
			  "      (",
			  "        name = "disk1",",
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
			  "        service = "worker1",",
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
			  "        uniqueKey = "do:worker1:Counter",",
			  "      ),",
			  "    ],",
			  "  durableObjectStorage = ( localDisk = "disk1" ),",
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

		const model = prepareConfigForSerialization(normalizeEmbeddedPaths(config, root), {
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

function normalizeEmbeddedPaths<T>(value: T, baseDirectory: string): T {
	if (isEmbeddedPath(value)) {
		const embeddedPath = getEmbeddedPath(value);
		return embed(path.isAbsolute(embeddedPath) ? embeddedPath : path.resolve(baseDirectory, embeddedPath)) as T;
	}

	if (Array.isArray(value)) {
		return value.map((item) => normalizeEmbeddedPaths(item, baseDirectory)) as T;
	}

	if (typeof value !== "object" || value === null) {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, nestedValue]) => [key, normalizeEmbeddedPaths(nestedValue, baseDirectory)]),
	) as T;
}
