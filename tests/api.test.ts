import { describe, expect, it } from "vitest";

import {
	createDisk,
	createExternalServer,
	createNetwork,
	createWorker,
	defineConfig,
	durableObject,
	embed,
	workerEntrypoint,
} from "../src/index";

describe("defineConfig", () => {
	it("resolves named entrypoints, props, and durable objects from socket roots", () => {
		const storage = createDisk({
			path: "./.data/do",
			writable: true,
		});
		const network = createNetwork({
			allow: ["public"],
			deny: ["private"],
		});
		const origin = createExternalServer({
			address: "example.com:443",
			tcp: {
				certificateHost: "example.com",
			},
		});
		const analytics = createWorker("./src/analytics.ts", {
			compatibilityDate: "2025-08-01",
		});
		const liveTail = createWorker("./src/live-tail.ts", {
			compatibilityDate: "2025-08-01",
		});

		const auth = createWorker("./src/auth.ts", {
			compatibilityDate: "2025-08-01",
			durableObjectStorage: { disk: storage },
			exports: {
				Auth: workerEntrypoint<{ issuer: string }>(),
				Counter: durableObject({ preventEviction: true }),
			},
		});

		const app = createWorker("./src/app.ts", {
			compatibilityDate: "2025-08-01",
			bindings: {
				AUTH: auth.exports.Auth({
					props: { issuer: "https://issuer.example" },
				}),
				COUNTERS: auth.exports.Counter(),
			},
			globalOutbound: network,
			cacheApiOutbound: origin,
			tails: [analytics],
			streamingTails: [liveTail],
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

		expect(config).toMatchInlineSnapshot(`
			{
			  "autogates": undefined,
			  "extensions": undefined,
			  "services": [
			    {
			      "name": "worker:1",
			      "worker": {
			        "bindings": [
			          {
			            "name": "AUTH",
			            "service": {
			              "entrypoint": "Auth",
			              "name": "worker:2",
			              "props": {
			                "json": "{"issuer":"https://issuer.example"}",
			              },
			            },
			          },
			          {
			            "durableObjectNamespace": {
			              "className": "Counter",
			              "serviceName": "worker:2",
			            },
			            "name": "COUNTERS",
			          },
			        ],
			        "cacheApiOutbound": {
			          "name": "external:1",
			        },
			        "compatibilityDate": "2025-08-01",
			        "compatibilityFlags": undefined,
			        "durableObjectNamespaces": undefined,
			        "durableObjectStorage": undefined,
			        "globalOutbound": "network:1",
			        "modules": [
			          {
			            "esModule": {
			              Symbol(capnp.embed): "./src/app.ts",
			            },
			            "name": "main",
			          },
			        ],
			        "streamingTails": [
			          "worker:4",
			        ],
			        "tails": [
			          "worker:3",
			        ],
			      },
			    },
			    {
			      "name": "worker:2",
			      "worker": {
			        "bindings": [],
			        "cacheApiOutbound": undefined,
			        "compatibilityDate": "2025-08-01",
			        "compatibilityFlags": undefined,
			        "durableObjectNamespaces": [
			          {
			            "className": "Counter",
			            "ephemeralLocal": undefined,
			            "preventEviction": true,
			            "uniqueKey": "do:worker:2:Counter",
			          },
			        ],
			        "durableObjectStorage": {
			          "localDisk": "disk:1",
			        },
			        "globalOutbound": undefined,
			        "modules": [
			          {
			            "esModule": {
			              Symbol(capnp.embed): "./src/auth.ts",
			            },
			            "name": "main",
			          },
			        ],
			        "streamingTails": undefined,
			        "tails": undefined,
			      },
			    },
			    {
			      "disk": {
			        "path": "./.data/do",
			        "writable": true,
			      },
			      "name": "disk:1",
			    },
			    {
			      "name": "network:1",
			      "network": {
			        "allow": [
			          "public",
			        ],
			        "deny": [
			          "private",
			        ],
			      },
			    },
			    {
			      "external": {
			        "address": "example.com:443",
			        "tcp": {
			          "certificateHost": "example.com",
			        },
			      },
			      "name": "external:1",
			    },
			    {
			      "name": "worker:3",
			      "worker": {
			        "bindings": [],
			        "cacheApiOutbound": undefined,
			        "compatibilityDate": "2025-08-01",
			        "compatibilityFlags": undefined,
			        "durableObjectNamespaces": undefined,
			        "durableObjectStorage": undefined,
			        "globalOutbound": undefined,
			        "modules": [
			          {
			            "esModule": {
			              Symbol(capnp.embed): "./src/analytics.ts",
			            },
			            "name": "main",
			          },
			        ],
			        "streamingTails": undefined,
			        "tails": undefined,
			      },
			    },
			    {
			      "name": "worker:4",
			      "worker": {
			        "bindings": [],
			        "cacheApiOutbound": undefined,
			        "compatibilityDate": "2025-08-01",
			        "compatibilityFlags": undefined,
			        "durableObjectNamespaces": undefined,
			        "durableObjectStorage": undefined,
			        "globalOutbound": undefined,
			        "modules": [
			          {
			            "esModule": {
			              Symbol(capnp.embed): "./src/live-tail.ts",
			            },
			            "name": "main",
			          },
			        ],
			        "streamingTails": undefined,
			        "tails": undefined,
			      },
			    },
			  ],
			  "sockets": [
			    {
			      "address": "*:8787",
			      "http": {},
			      "name": "app",
			      "service": "worker:1",
			    },
			  ],
			  "structuredLogging": undefined,
			  "v8Flags": undefined,
			}
		`);
	});

	it("requires durableObjectStorage when a worker exports a durable object", () => {
		const app = createWorker("./src/index.ts", {
			compatibilityDate: "2025-08-01",
			exports: {
				Counter: durableObject(),
			},
		});

		expect(() =>
			defineConfig({
				sockets: [
					app.listen({
						name: "app",
						protocol: "http",
					}),
				],
			}),
		).toThrowError(
			"Workers with Durable Object exports must declare durableObjectStorage.",
		);
	});

	it("resolves exports.default props without an explicit entrypoint field", () => {
		const app = createWorker("./src/index.ts", {
			compatibilityDate: "2025-08-01",
			exports: {
				default: workerEntrypoint<{ issuer: string }>(),
			},
		});

		const proxy = createWorker("./src/proxy.ts", {
			compatibilityDate: "2025-08-01",
			bindings: {
				APP: app.exports.default({
					props: {
						issuer: "https://issuer.example",
					},
				}),
			},
		});

		const config = defineConfig({
			sockets: [
				proxy.listen({
					name: "app",
					protocol: "http",
				}),
			],
		});

		expect(config.services[0]).toEqual({
			name: "worker:1",
			worker: {
				modules: [{ name: "main", esModule: embed("./src/proxy.ts") }],
				compatibilityDate: "2025-08-01",
				compatibilityFlags: undefined,
				bindings: [
					{
						name: "APP",
						service: {
							entrypoint: undefined,
							name: "worker:2",
							props: {
								json: '{"issuer":"https://issuer.example"}',
							},
						},
					},
				],
				durableObjectNamespaces: undefined,
				durableObjectStorage: undefined,
				globalOutbound: undefined,
				cacheApiOutbound: undefined,
				tails: undefined,
				streamingTails: undefined,
			},
		});
	});
});

describe("durableObject", () => {
	it("rejects durable objects that set both ephemeralLocal and uniqueKey", () => {
		expect(() =>
			durableObject({ ephemeralLocal: true, uniqueKey: "counter" }),
		).toThrowError(
			"Durable Object exports cannot set both `ephemeralLocal` and `uniqueKey`.",
		);
	});
})
