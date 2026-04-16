import { fileURLToPath } from "node:url";

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

function fixtureUrl(relativePath: string): URL {
	return new URL(relativePath, import.meta.url);
}

function fixturePath(relativePath: string): string {
	return fileURLToPath(fixtureUrl(relativePath));
}

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
		const analytics = createWorker({
			entry: fixtureUrl("./src/analytics.ts"),
			compatibilityDate: "2025-08-01",
		});
		const liveTail = createWorker({
			entry: fixtureUrl("./src/live-tail.ts"),
			compatibilityDate: "2025-08-01",
		});

		const auth = createWorker({
			entry: fixtureUrl("./src/auth.ts"),
			compatibilityDate: "2025-08-01",
			durableObjectStorage: { disk: storage },
			exports: {
				Auth: workerEntrypoint<{ issuer: string }>(),
				Counter: durableObject({ preventEviction: true }),
			},
		});

		const app = createWorker({
			entry: fixtureUrl("./src/app.ts"),
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

		expect(config).toEqual({
			autogates: undefined,
			extensions: undefined,
			services: [
				{
					name: "worker1",
					worker: {
						bindings: [
							{
								name: "AUTH",
								service: {
									entrypoint: "Auth",
									name: "worker2",
									props: {
										json: '{"issuer":"https://issuer.example"}',
									},
								},
							},
							{
								durableObjectNamespace: {
									className: "Counter",
									serviceName: "worker2",
								},
								name: "COUNTERS",
							},
						],
						cacheApiOutbound: { name: "external1" },
						compatibilityDate: "2025-08-01",
						compatibilityFlags: undefined,
						durableObjectNamespaces: undefined,
						durableObjectStorage: undefined,
						globalOutbound: "network1",
						modules: [{ name: "main", esModule: embed(fixturePath("./src/app.ts")) }],
						streamingTails: ["worker4"],
						tails: ["worker3"],
					},
				},
				{
					name: "worker2",
					worker: {
						bindings: [],
						cacheApiOutbound: undefined,
						compatibilityDate: "2025-08-01",
						compatibilityFlags: undefined,
						durableObjectNamespaces: [
							{
								className: "Counter",
								ephemeralLocal: undefined,
								preventEviction: true,
								uniqueKey: "do:worker2:Counter",
							},
						],
						durableObjectStorage: { localDisk: "disk1" },
						globalOutbound: undefined,
						modules: [{ name: "main", esModule: embed(fixturePath("./src/auth.ts")) }],
						streamingTails: undefined,
						tails: undefined,
					},
				},
				{
					disk: {
						path: "./.data/do",
						writable: true,
					},
					name: "disk1",
				},
				{
					name: "network1",
					network: {
						allow: ["public"],
						deny: ["private"],
					},
				},
				{
					external: {
						address: "example.com:443",
						tcp: {
							certificateHost: "example.com",
						},
					},
					name: "external1",
				},
				{
					name: "worker3",
					worker: {
						bindings: [],
						cacheApiOutbound: undefined,
						compatibilityDate: "2025-08-01",
						compatibilityFlags: undefined,
						durableObjectNamespaces: undefined,
						durableObjectStorage: undefined,
						globalOutbound: undefined,
						modules: [{ name: "main", esModule: embed(fixturePath("./src/analytics.ts")) }],
						streamingTails: undefined,
						tails: undefined,
					},
				},
				{
					name: "worker4",
					worker: {
						bindings: [],
						cacheApiOutbound: undefined,
						compatibilityDate: "2025-08-01",
						compatibilityFlags: undefined,
						durableObjectNamespaces: undefined,
						durableObjectStorage: undefined,
						globalOutbound: undefined,
						modules: [{ name: "main", esModule: embed(fixturePath("./src/live-tail.ts")) }],
						streamingTails: undefined,
						tails: undefined,
					},
				},
			],
			sockets: [
				{
					address: "*:8787",
					http: {},
					name: "app",
					service: "worker1",
				},
			],
			structuredLogging: undefined,
			v8Flags: undefined,
		});
	});

	it("rejects relative helper worker entry strings", () => {
		expect(() => createWorker({ entry: "./src/index.ts" })).toThrowError(
			'createWorker() entry must be an absolute path or file URL. Use new URL("./src/index.ts", import.meta.url) instead of a relative string.',
		);
	});

	it("rejects non-file URL worker entries", () => {
		expect(() => createWorker({ entry: new URL("https://example.com/index.ts") })).toThrowError(
			'createWorker() only accepts file URLs. Received "https://example.com/index.ts".',
		);
	});

	it("requires durableObjectStorage when a worker exports a durable object", () => {
		const app = createWorker({
			entry: fixtureUrl("./src/index.ts"),
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
		const app = createWorker({
			entry: fixtureUrl("./src/index.ts"),
			compatibilityDate: "2025-08-01",
			exports: {
				default: workerEntrypoint<{ issuer: string }>(),
			},
		});

		const proxy = createWorker({
			entry: fixtureUrl("./src/proxy.ts"),
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
			name: "worker1",
			worker: {
				modules: [{ name: "main", esModule: embed(fixturePath("./src/proxy.ts")) }],
				compatibilityDate: "2025-08-01",
				compatibilityFlags: undefined,
				bindings: [
					{
						name: "APP",
						service: {
							entrypoint: undefined,
							name: "worker2",
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

	it("exposes a default binding accessor without declaring exports.default", () => {
		const greet = createWorker({
			entry: fixtureUrl("./src/greet.ts"),
			compatibilityDate: "2025-08-01",
		});

		const app = createWorker({
			entry: fixtureUrl("./src/index.ts"),
			compatibilityDate: "2025-08-01",
			bindings: {
				GREET: greet.exports.default(),
			},
		});

		const config = defineConfig({
			sockets: [
				app.listen({
					name: "app",
					protocol: "http",
				}),
			],
		});

		expect(config.services[0]).toEqual({
			name: "worker1",
			worker: {
				modules: [{ name: "main", esModule: embed(fixturePath("./src/index.ts")) }],
				compatibilityDate: "2025-08-01",
				compatibilityFlags: undefined,
				bindings: [
					{
						name: "GREET",
						service: {
							entrypoint: undefined,
							name: "worker2",
							props: undefined,
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
