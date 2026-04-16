import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createServer, type Plugin, type ViteDevServer } from "vite";
import { describe, expect, it, onTestFinished } from "vitest";

import { getWorkerdDevRuntime } from "../src/plugins/dev";
import { workerd } from "../src/index";

const syntaxModulePath = JSON.stringify(path.resolve(process.cwd(), "src", "config", "syntax.ts"));

describe("workerd vite dev plugin", () => {
	it("proxies localhost to the first socket and named subdomains to matching sockets", async () => {
		const root = createTempProjectRoot();

		fs.writeFileSync(
			path.join(root, "src", "app.ts"),
			"export default { async fetch() { return new Response('app'); } };\n",
		);
		fs.writeFileSync(
			path.join(root, "src", "admin.ts"),
			"export default { async fetch() { return new Response('admin'); } };\n",
		);
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/app.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"    {",
				"      name: 'admin-service',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/admin.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    { name: 'app', address: '*:0', http: {}, service: 'app' },",
				"    { name: 'admin', address: '*:0', http: {}, service: 'admin-service' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const server = await startDevServer(root);
		const port = getServerPort(server);

		expect(await waitForTextResponse(port, `localhost:${port}`)).toBe("app");
		expect(await waitForTextResponse(port, `admin.localhost:${port}`)).toBe("admin");
	}, 20_000);

	it("uses the configured default socket for bare localhost requests", async () => {
		const root = createTempProjectRoot();

		fs.writeFileSync(
			path.join(root, "src", "app.ts"),
			"export default { async fetch() { return new Response('app'); } };\n",
		);
		fs.writeFileSync(
			path.join(root, "src", "admin.ts"),
			"export default { async fetch() { return new Response('admin'); } };\n",
		);
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/app.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"    {",
				"      name: 'admin-service',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/admin.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    { name: 'app', address: '*:0', http: {}, service: 'app' },",
				"    { name: 'admin', address: '*:0', http: {}, service: 'admin-service' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const server = await startDevServer(root, { defaultSocket: "admin" });
		const port = getServerPort(server);

		expect(await waitForTextResponse(port, `localhost:${port}`)).toBe("admin");
	}, 20_000);

	it("proxies path and query strings to workerd before Vite html fallback", async () => {
		const root = createTempProjectRoot();

		fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><html><body>vite</body></html>\n");
		fs.writeFileSync(
			path.join(root, "src", "index.ts"),
			[
				"export default {",
				"  async fetch(request) {",
				"    const url = new URL(request.url);",
				"    return new Response(`${url.pathname}${url.search}`);",
				"  },",
				"};",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/index.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    { name: 'app', address: '*:0', http: {}, service: 'app' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const server = await startDevServer(root);
		const port = getServerPort(server);

		expect(await requestText(port, `localhost:${port}`, "/deep/path?name=value&x=1")).toBe(
			"/deep/path?name=value&x=1",
		);
	}, 20_000);

	it("hot reloads the default worker without restarting workerd or changing the Vite port", async () => {
		const root = createTempProjectRoot();

		fs.writeFileSync(path.join(root, "src", "message.ts"), "export default 'one';\n");
		fs.writeFileSync(
			path.join(root, "src", "index.ts"),
			"import message from './message.ts'; export default { async fetch() { return new Response(message); } };\n",
		);
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/index.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    { name: 'app', address: '*:0', http: {}, service: 'app' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const server = await startDevServer(root);
		const port = getServerPort(server);
		const workerdPid = getWorkerdDevRuntime(server)?.getPid();

		if (!workerdPid) {
			throw new Error("Expected workerd to be running in dev mode.");
		}

		expect(await waitForTextResponse(port, `localhost:${port}`)).toBe("one");

		fs.writeFileSync(path.join(root, "src", "message.ts"), "export default 'two';\n");

		expect(await waitForTextResponse(port, `localhost:${port}`, "two")).toBe("two");
		expect(getWorkerdDevRuntime(server)?.getPid()).toBe(workerdPid);
		expect(getServerPort(server)).toBe(port);
	}, 20_000);

	it("hot reloads named entrypoints and preserves config props without restarting workerd", async () => {
		const root = createTempProjectRoot();

		fs.writeFileSync(path.join(root, "src", "message.ts"), "export default 'one';\n");
		fs.writeFileSync(
			path.join(root, "src", "index.ts"),
			[
				"import { WorkerEntrypoint } from 'cloudflare:workers';",
				"import message from './message.ts';",
				"export default { async fetch() { return new Response('default'); } };",
				"export class Alt extends WorkerEntrypoint {",
				"  async fetch() {",
				"    return new Response(`${String(this.ctx.props?.issuer ?? 'missing')}:${message}`);",
				"  }",
				"}",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/index.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    {",
				"      name: 'app',",
				"      address: '*:0',",
				"      http: {},",
				"      service: {",
				"        name: 'app',",
				"        entrypoint: 'Alt',",
				"        props: { json: '{\"issuer\":\"expected\"}' },",
				"      },",
				"    },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const server = await startDevServer(root);
		const port = getServerPort(server);
		const workerdPid = getWorkerdDevRuntime(server)?.getPid();

		if (!workerdPid) {
			throw new Error("Expected workerd to be running in dev mode.");
		}

		expect(await waitForTextResponse(port, `localhost:${port}`)).toBe("expected:one");

		fs.writeFileSync(path.join(root, "src", "message.ts"), "export default 'two';\n");

		expect(await waitForTextResponse(port, `localhost:${port}`, "expected:two")).toBe("expected:two");
		expect(getWorkerdDevRuntime(server)?.getPid()).toBe(workerdPid);
		expect(getServerPort(server)).toBe(port);
	}, 20_000);

	it("supports inter-worker RPC to a hot named entrypoint without restarting workerd", async () => {
		const root = createTempProjectRoot();

		fs.writeFileSync(path.join(root, "src", "message.ts"), "export default 'one';\n");
		fs.writeFileSync(
			path.join(root, "src", "app.ts"),
			[
				"import { WorkerEntrypoint } from 'cloudflare:workers';",
				"import message from './message.ts';",
				"export default { async fetch() { return new Response('default'); } };",
				"export class Greeter extends WorkerEntrypoint {",
				"  greet(name) {",
				"    return `${String(this.ctx.props?.issuer ?? 'missing')}:${name}:${message}`;",
				"  }",
				"}",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(root, "src", "caller.ts"),
			[
				"export default {",
				"  async fetch(_request, env) {",
				"    return new Response(await env.HOT.greet('alice'));",
				"  },",
				"};",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/app.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"    {",
				"      name: 'caller',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/caller.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"        bindings: [",
				"          { name: 'HOT', service: { name: 'app', entrypoint: 'Greeter', props: { json: '{\"issuer\":\"expected\"}' } } },",
				"        ],",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    { name: 'app', address: '*:0', http: {}, service: 'app' },",
				"    { name: 'caller', address: '*:0', http: {}, service: 'caller' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const server = await startDevServer(root);
		const port = getServerPort(server);
		const workerdPid = getWorkerdDevRuntime(server)?.getPid();

		if (!workerdPid) {
			throw new Error("Expected workerd to be running in dev mode.");
		}

		expect(await waitForTextResponse(port, `caller.localhost:${port}`)).toBe("expected:alice:one");

		fs.writeFileSync(path.join(root, "src", "message.ts"), "export default 'two';\n");

		expect(await waitForTextResponse(port, `caller.localhost:${port}`, "expected:alice:two")).toBe("expected:alice:two");
		expect(getWorkerdDevRuntime(server)?.getPid()).toBe(workerdPid);
	}, 20_000);

	it("supports inter-worker RPC to the hot default entrypoint without restarting workerd", async () => {
		const root = createTempProjectRoot();

		fs.writeFileSync(path.join(root, "src", "message.ts"), "export default 'one';\n");
		fs.writeFileSync(
			path.join(root, "src", "app.ts"),
			[
				"import { WorkerEntrypoint } from 'cloudflare:workers';",
				"import message from './message.ts';",
				"export default class extends WorkerEntrypoint {",
				"  greet(name) {",
				"    return `${String(this.ctx.props?.issuer ?? 'missing')}:${name}:${message}`;",
				"  }",
				"  async fetch() {",
				"    return new Response('default');",
				"  }",
				"}",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(root, "src", "caller.ts"),
			[
				"export default {",
				"  async fetch(_request, env) {",
				"    return new Response(await env.HOT.greet('alice'));",
				"  },",
				"};",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/app.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"    {",
				"      name: 'caller',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/caller.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"        bindings: [",
				"          { name: 'HOT', service: { name: 'app', props: { json: '{\"issuer\":\"expected\"}' } } },",
				"        ],",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    { name: 'app', address: '*:0', http: {}, service: 'app' },",
				"    { name: 'caller', address: '*:0', http: {}, service: 'caller' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const server = await startDevServer(root);
		const port = getServerPort(server);
		const workerdPid = getWorkerdDevRuntime(server)?.getPid();

		if (!workerdPid) {
			throw new Error("Expected workerd to be running in dev mode.");
		}

		expect(await waitForTextResponse(port, `caller.localhost:${port}`)).toBe("expected:alice:one");

		fs.writeFileSync(path.join(root, "src", "message.ts"), "export default 'two';\n");

		expect(await waitForTextResponse(port, `caller.localhost:${port}`, "expected:alice:two")).toBe("expected:alice:two");
		expect(getWorkerdDevRuntime(server)?.getPid()).toBe(workerdPid);
	}, 20_000);

	it("supports ctx.exports in the hot worker request path", async () => {
		const root = createTempProjectRoot();

		fs.writeFileSync(path.join(root, "src", "message.ts"), "export default 'one';\n");
		fs.writeFileSync(
			path.join(root, "src", "index.ts"),
			[
				"import { WorkerEntrypoint } from 'cloudflare:workers';",
				"import message from './message.ts';",
				"export default class extends WorkerEntrypoint {",
				"  async fetch() {",
				"    return new Response(await this.ctx.exports.Alt.greet(message));",
				"  }",
				"}",
				"export class Alt extends WorkerEntrypoint {",
				"  greet(value) {",
				"    return `hello:${value}`;",
				"  }",
				"}",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/index.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    { name: 'app', address: '*:0', http: {}, service: 'app' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const server = await startDevServer(root);
		const port = getServerPort(server);
		const workerdPid = getWorkerdDevRuntime(server)?.getPid();

		if (!workerdPid) {
			throw new Error("Expected workerd to be running in dev mode.");
		}

		expect(await waitForTextResponse(port, `localhost:${port}`)).toBe("hello:one");

		fs.writeFileSync(path.join(root, "src", "message.ts"), "export default 'two';\n");

		expect(await waitForTextResponse(port, `localhost:${port}`, "hello:two")).toBe("hello:two");
		expect(getWorkerdDevRuntime(server)?.getPid()).toBe(workerdPid);
	}, 20_000);

	it("does not resurrect stale worker code after rapid consecutive edits", async () => {
		const root = createTempProjectRoot();

		fs.writeFileSync(path.join(root, "src", "message.ts"), "export default 'one';\n");
		fs.writeFileSync(
			path.join(root, "src", "index.ts"),
			"import message from './message.ts'; export default { async fetch() { return new Response(message); } };\n",
		);
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/index.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    { name: 'app', address: '*:0', http: {}, service: 'app' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const delayHotTwoPlugin: Plugin = {
			name: "delay-hot-two",
			apply: "serve",
			transform(code, id) {
				if (!id.includes("/src/message.ts") || !code.includes("export default 'two'")) {
					return;
				}

				return new Promise((resolve) => {
					setTimeout(() => resolve(null), 250);
				});
			},
		};

		const server = await startDevServer(root, { plugins: [delayHotTwoPlugin] });
		const port = getServerPort(server);

		expect(await waitForTextResponse(port, `localhost:${port}`)).toBe("one");

		fs.writeFileSync(path.join(root, "src", "message.ts"), "export default 'two';\n");
		await new Promise((resolve) => setTimeout(resolve, 50));

		const staleRequest = requestText(port, `localhost:${port}`);

		await new Promise((resolve) => setTimeout(resolve, 50));
		fs.writeFileSync(path.join(root, "src", "message.ts"), "export default 'three';\n");

		await staleRequest;
		expect(await waitForTextResponse(port, `localhost:${port}`, "three")).toBe("three");
	}, 20_000);

	it("supports optimized CommonJS deps with named imports in the hot worker path", async () => {
		const root = createTempProjectRoot();
		fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "node_modules", "dep", "package.json"),
			JSON.stringify({ name: "dep", version: "1.0.0", main: "./index.js" }, null, 2),
		);
		fs.writeFileSync(
			path.join(root, "node_modules", "dep", "index.js"),
			"module.exports = { greeting: 'hello', suffix: 'one' };\n",
		);
		fs.writeFileSync(
			path.join(root, "src", "index.ts"),
			"import { greeting, suffix } from 'dep'; export default { async fetch() { return new Response(`${greeting}:${suffix}`); } };\n",
		);
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/index.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    { name: 'app', address: '*:0', http: {}, service: 'app' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const server = await startDevServer(root);
		const port = getServerPort(server);

		expect(await waitForTextResponse(port, `localhost:${port}`)).toBe("hello:one");
	}, 20_000);

	it("hot reloads a secondary worker in the fixed graph without restarting workerd", async () => {
		const root = createTempProjectRoot();

		fs.writeFileSync(path.join(root, "src", "app.ts"), "export default { async fetch() { return new Response('app'); } };\n");
		fs.writeFileSync(path.join(root, "src", "admin.ts"), "export default { async fetch() { return new Response('admin:one'); } };\n");
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/app.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"    {",
				"      name: 'admin-service',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/admin.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    { name: 'app', address: '*:0', http: {}, service: 'app' },",
				"    { name: 'admin', address: '*:0', http: {}, service: 'admin-service' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const server = await startDevServer(root);
		const port = getServerPort(server);
		const workerdPid = getWorkerdDevRuntime(server)?.getPid();

		if (!workerdPid) {
			throw new Error("Expected workerd to be running in dev mode.");
		}

		expect(await waitForTextResponse(port, `admin.localhost:${port}`)).toBe("admin:one");

		fs.writeFileSync(path.join(root, "src", "admin.ts"), "export default { async fetch() { return new Response('admin:two'); } };\n");

		expect(await waitForTextResponse(port, `admin.localhost:${port}`, "admin:two")).toBe("admin:two");
		expect(getWorkerdDevRuntime(server)?.getPid()).toBe(workerdPid);
	}, 20_000);

	it("hot reloads a bound worker used by another worker without restarting workerd", async () => {
		const root = createTempProjectRoot();

		fs.writeFileSync(path.join(root, "src", "app.ts"), "export default { async fetch() { return new Response('app'); } };\n");
		fs.writeFileSync(path.join(root, "src", "admin.ts"), "export default { async fetch() { return new Response('admin:one'); } };\n");
		fs.writeFileSync(
			path.join(root, "src", "caller.ts"),
			[
				"export default {",
				"  async fetch(_request, env) {",
				"    const response = await env.ADMIN.fetch('http://example.com/');",
				"    return new Response(await response.text());",
				"  },",
				"};",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/app.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"    {",
				"      name: 'admin-service',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/admin.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"    {",
				"      name: 'caller',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/caller.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"        bindings: [",
				"          { name: 'ADMIN', service: 'admin-service' },",
				"        ],",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    { name: 'app', address: '*:0', http: {}, service: 'app' },",
				"    { name: 'caller', address: '*:0', http: {}, service: 'caller' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const server = await startDevServer(root);
		const port = getServerPort(server);
		const workerdPid = getWorkerdDevRuntime(server)?.getPid();

		if (!workerdPid) {
			throw new Error("Expected workerd to be running in dev mode.");
		}

		expect(await waitForTextResponse(port, `caller.localhost:${port}`)).toBe("admin:one");

		fs.writeFileSync(path.join(root, "src", "admin.ts"), "export default { async fetch() { return new Response('admin:two'); } };\n");

		expect(await waitForTextResponse(port, `caller.localhost:${port}`, "admin:two")).toBe("admin:two");
		expect(getWorkerdDevRuntime(server)?.getPid()).toBe(workerdPid);
	}, 20_000);
});

function createTempProjectRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vite-plugin-workerd-dev-"));
	onTestFinished(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	fs.mkdirSync(path.join(root, "src"), { recursive: true });

	return root;
}

async function startDevServer(
	root: string,
	options: { defaultSocket?: string; plugins?: Plugin[] } = {},
): Promise<ViteDevServer> {
	const server = await createServer({
		root,
		logLevel: "silent",
		server: {
			host: "127.0.0.1",
			port: 0,
		},
		plugins: [workerd(options), ...(options.plugins ?? [])],
	});

	onTestFinished(async () => {
		await server.close();
	});

	await server.listen();
	return server;
}

function getServerPort(server: ViteDevServer): number {
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") {
		throw new Error("Vite dev server did not expose a numeric port.");
	}

	return address.port;
}

async function waitForTextResponse(
	port: number,
	hostHeader: string,
	expectedText?: string,
): Promise<string> {
	const startedAt = Date.now();
	let lastError: unknown;

	while (Date.now() - startedAt < 10_000) {
		try {
			const response = await requestText(port, hostHeader);
			if (expectedText === undefined || response === expectedText) {
				return response;
			}
		} catch (error) {
			lastError = error;
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	throw new Error(
		`Timed out waiting for ${hostHeader} to respond${expectedText ? ` with ${expectedText}` : ""}. ${String(lastError)}`,
	);
}

async function requestText(port: number, hostHeader: string, requestPath = "/"): Promise<string> {
	return await new Promise((resolve, reject) => {
		const request = http.request(
			{
				host: "127.0.0.1",
				port,
				path: requestPath,
				method: "GET",
				headers: {
					host: hostHeader,
				},
			},
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					body += chunk;
				});
				response.on("end", () => {
					if ((response.statusCode ?? 500) >= 400) {
						reject(new Error(`Request failed with ${String(response.statusCode)}: ${body}`));
						return;
					}

					resolve(body);
				});
			},
		);

		request.on("error", reject);
		request.end();
	});
}
