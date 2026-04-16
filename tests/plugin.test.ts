import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { describe, expect, it, onTestFinished } from "vitest";
import { createBuilder } from "vite";

import { createWorker, defineConfig, embed, workerd } from "../src/index";

const workerdBin = path.resolve(process.cwd(), "node_modules", ".bin", "workerd");
const syntaxModulePath = JSON.stringify(path.resolve(process.cwd(), "src", "config", "syntax.ts"));

describe("workerd vite plugin", () => {
	it("emits dist/workerd.capnp and runs it with workerd", async () => {
		const root = createTempProjectRoot();
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

		const builder = await createBuilder({
			root,
			logLevel: "silent",
			plugins: [workerd()],
			build: {
				outDir: "dist",
				emptyOutDir: true,
			},
		});
		await builder.buildApp();

		const configPath = path.join(root, "dist", "workerd.capnp");
		const source = fs.readFileSync(configPath, "utf8");

		expect(source).toContain('const config :Workerd.Config =');
		expect(source).toContain('esModule = embed "workers/app.js"');
		expect(source).toContain('address = "*:0"');
		expect(fs.existsSync(path.join(root, "dist", "workers", "app.js"))).toBe(true);

		const workerdProcess = spawn(
			workerdBin,
			["serve", "--control-fd=3", configPath],
			{
				cwd: root,
				stdio: ["ignore", "pipe", "pipe", "pipe"],
			},
		);
		onTestFinished(() => {
			terminateChildProcess(workerdProcess);
		});

		const port = await waitForListenPort(workerdProcess, "app");
		const response = await waitForResponse(`http://127.0.0.1:${port}/`);
		expect(await response.text()).toBe("ok");
	}, 15_000);

	it("loads a custom configFile", async () => {
		const root = createTempProjectRoot();
		fs.mkdirSync(path.join(root, "configs"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "configs", "workerd.custom.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('../src/index.ts') }],",
				"        compatibilityDate: '2025-08-01',",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    { name: 'app', address: '*:8787', http: {}, service: 'app' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const builder = await createBuilder({
			root,
			logLevel: "silent",
			plugins: [
				workerd({
					configFile: "configs/workerd.custom.ts",
				}),
			],
			build: {
				outDir: "dist",
				emptyOutDir: true,
			},
		});
		await builder.buildApp();

		const configPath = path.join(root, "dist", "workerd.capnp");
		const source = fs.readFileSync(configPath, "utf8");

		expect(source).toContain('esModule = embed "workers/app.js"');
		expect(source).toContain('address = "*:8787"');
	});

	it("discovers workerd.config.js and supports callback exports", async () => {
		const root = createTempProjectRoot();
		fs.writeFileSync(
			path.join(root, "workerd.config.js"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default ({ mode }) => ({",
				"  services: [",
				"    {",
				"      name: 'app',",
				"      worker: {",
				"        modules: [{ name: 'main', esModule: embed('./src/index.ts') }],",
				"        compatibilityDate: mode === 'production' ? '2025-08-01' : '2025-08-02',",
				"      },",
				"    },",
				"  ],",
				"  sockets: [",
				"    { name: 'app', address: '*:8787', http: {}, service: 'app' },",
				"  ],",
				"});",
				"",
			].join("\n"),
		);

		const builder = await createBuilder({
			root,
			mode: "production",
			logLevel: "silent",
			plugins: [workerd()],
			build: {
				outDir: "dist",
				emptyOutDir: true,
			},
		});
		await builder.buildApp();

		const configPath = path.join(root, "dist", "workerd.capnp");
		const source = fs.readFileSync(configPath, "utf8");

		expect(source).toContain('compatibilityDate = "2025-08-01"');
		expect(source).toContain('esModule = embed "workers/app.js"');
	});

	it("throws a clear error when no default config file exists", async () => {
		const root = createTempProjectRoot();

		await expect(
			createBuilder({
				root,
				logLevel: "silent",
				plugins: [workerd()],
				build: {
					outDir: "dist",
					emptyOutDir: true,
				},
			}),
		).rejects.toThrowError(
			/Could not find a default workerd config file matching workerd\.config\.\{.*\}\./,
		);
	});

	it("throws when loaded config does not include services and sockets arrays", async () => {
		const root = createTempProjectRoot();
		fs.writeFileSync(path.join(root, "workerd.config.ts"), "export default {}\n");

		await expect(
			createBuilder({
				root,
				logLevel: "silent",
				plugins: [workerd()],
				build: {
					outDir: "dist",
					emptyOutDir: true,
				},
			}),
		).rejects.toThrowError(/workerd config must include "services" and "sockets" arrays\./);
	});

	it("resolves inline config paths from viteConfig.root", async () => {
		const root = createTempProjectRoot();

		const builder = await createBuilder({
			root,
			logLevel: "silent",
			plugins: [
				workerd({
					config: {
						services: [
							{
								name: "app",
								worker: {
									modules: [{ name: "main", esModule: embed("./src/index.ts") }],
									compatibilityDate: "2025-08-01",
								},
							},
						],
						sockets: [
							{ name: "app", address: "*:8787", http: {}, service: "app" },
						],
					},
				}),
			],
			build: {
				outDir: "dist",
				emptyOutDir: true,
			},
		});
		await builder.buildApp();

		const configPath = path.join(root, "dist", "workerd.capnp");
		const source = fs.readFileSync(configPath, "utf8");

		expect(source).toContain('esModule = embed "workers/app.js"');
		expect(source).toContain('address = "*:8787"');
	});

	it("supports inline callback config", async () => {
		const root = createTempProjectRoot();

		const builder = await createBuilder({
			root,
			mode: "production",
			logLevel: "silent",
			plugins: [
				workerd({
					config: () => ({
						services: [
							{
								name: "app",
								worker: {
									modules: [{ name: "main", esModule: embed("./src/index.ts") }],
									compatibilityDate: "2025-08-01",
								},
							},
						],
						sockets: [
							{ name: "app", address: "*:8787", http: {}, service: "app" },
						],
					}),
				}),
			],
			build: {
				outDir: "dist",
				emptyOutDir: true,
			},
		});
		await builder.buildApp();

		const configPath = path.join(root, "dist", "workerd.capnp");
		const source = fs.readFileSync(configPath, "utf8");

		expect(source).toContain('compatibilityDate = "2025-08-01"');
		expect(source).toContain('esModule = embed "workers/app.js"');
	});

	it("resolves default workerd config relative to the active Vite config file", async () => {
		const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vite-plugin-workerd-config-root-"));
		onTestFinished(() => {
			fs.rmSync(workspaceRoot, { recursive: true, force: true });
		});

		const projectRoot = path.join(workspaceRoot, "app");
		fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(projectRoot, "src", "index.ts"),
			"export default { async fetch() { return new Response('ok'); } };\n",
		);
		fs.writeFileSync(
			path.join(projectRoot, "workerd.config.ts"),
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
		fs.writeFileSync(
			path.join(projectRoot, "vite.config.ts"),
			[
				`import { defineConfig } from ${JSON.stringify(path.resolve(process.cwd(), "node_modules", "vite", "dist", "node", "index.js"))};`,
				`import { workerd } from ${JSON.stringify(path.resolve(process.cwd(), "src", "index.ts"))};`,
				"",
				"export default defineConfig({",
				"  plugins: [workerd()],",
				"  build: { outDir: 'dist', emptyOutDir: true },",
				"});",
			].join("\n"),
		);

		const builder = await createBuilder({
			configFile: path.join(projectRoot, "vite.config.ts"),
			logLevel: "silent",
		});
		await builder.buildApp();

		expect(fs.existsSync(path.join(projectRoot, "dist", "workerd.capnp"))).toBe(true);
		expect(fs.existsSync(path.join(projectRoot, "dist", "workers", "app.js"))).toBe(true);
	});

	it("uses the generated service name for helper-authored worker output", async () => {
		const root = createTempProjectRoot();
		const app = createWorker({
			entry: path.join(root, "src", "index.ts"),
			compatibilityDate: "2025-08-01",
		});

		const builder = await createBuilder({
			root,
			logLevel: "silent",
			plugins: [
				workerd({
					config: defineConfig({
						sockets: [
							app.listen({
								name: "app",
								address: "*:0",
								protocol: "http",
							}),
						],
					}),
				}),
			],
			build: {
				outDir: "dist",
				emptyOutDir: true,
			},
		});
		await builder.buildApp();

		const source = fs.readFileSync(path.join(root, "dist", "workerd.capnp"), "utf8");
		expect(source).toContain('esModule = embed "workers/worker1.js"');
		expect(fs.existsSync(path.join(root, "dist", "workers", "worker1.js"))).toBe(true);
	});

	it("composes an existing builder.buildApp hook", async () => {
		const root = createTempProjectRoot();
		const markerPath = path.join(root, "builder-called.txt");

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

		const builder = await createBuilder({
			root,
			logLevel: "silent",
			plugins: [workerd()],
			builder: {
				async buildApp() {
					fs.writeFileSync(markerPath, "called\n");
				},
			},
			build: {
				outDir: "dist",
				emptyOutDir: true,
			},
		});
		await builder.buildApp();

		expect(fs.existsSync(markerPath)).toBe(true);
		expect(fs.existsSync(path.join(root, "dist", "workerd.capnp"))).toBe(true);
		expect(fs.existsSync(path.join(root, "dist", "workers", "app.js"))).toBe(true);
	});

	it("bundles two worker services and runs both sockets", async () => {
		const root = createTempProjectRoot();
		fs.writeFileSync(
			path.join(root, "src", "a.ts"),
			"export default { async fetch() { return new Response('a'); } };\n",
		);
		fs.writeFileSync(
			path.join(root, "src", "b.ts"),
			"export default { async fetch() { return new Response('b'); } };\n",
		);
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    { name: 'a', worker: { modules: [{ name: 'main', esModule: embed('./src/a.ts') }], compatibilityDate: '2025-08-01' } },",
				"    { name: 'b', worker: { modules: [{ name: 'main', esModule: embed('./src/b.ts') }], compatibilityDate: '2025-08-01' } },",
				"  ],",
				"  sockets: [",
				"    { name: 'a', address: '*:0', http: {}, service: 'a' },",
				"    { name: 'b', address: '*:0', http: {}, service: 'b' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		const builder = await createBuilder({
			root,
			logLevel: "silent",
			plugins: [workerd()],
			build: {
				outDir: "dist",
				emptyOutDir: true,
			},
		});
		await builder.buildApp();

		const configPath = path.join(root, "dist", "workerd.capnp");
		const source = fs.readFileSync(configPath, "utf8");
		expect(source).toContain('esModule = embed "workers/a.js"');
		expect(source).toContain('esModule = embed "workers/b.js"');

		const workerdProcess = spawn(workerdBin, ["serve", "--control-fd=3", configPath], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
		});
		onTestFinished(() => {
			terminateChildProcess(workerdProcess);
		});

		const [aPort, bPort] = await Promise.all([
			waitForListenPort(workerdProcess, "a"),
			waitForListenPort(workerdProcess, "b"),
		]);
		expect(await (await waitForResponse(`http://127.0.0.1:${aPort}/`)).text()).toBe("a");
		expect(await (await waitForResponse(`http://127.0.0.1:${bPort}/`)).text()).toBe("b");
	}, 15_000);

	it("flattens static extra worker modules into the main output and still runs", async () => {
		const root = createTempProjectRoot();
		fs.writeFileSync(
			path.join(root, "src", "index.ts"),
			"import message from './helper.ts'; export default { async fetch() { return new Response(message); } };\n",
		);
		fs.writeFileSync(path.join(root, "src", "helper.ts"), "export default 'helper';\n");
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
				"        modules: [",
				"          { name: 'main', esModule: embed('./src/index.ts') },",
				"          { name: 'helper', esModule: embed('./src/helper.ts') },",
				"        ],",
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

		const builder = await createBuilder({
			root,
			logLevel: "silent",
			plugins: [workerd()],
			build: {
				outDir: "dist",
				emptyOutDir: true,
			},
		});
		await builder.buildApp();

		const source = fs.readFileSync(path.join(root, "dist", "workerd.capnp"), "utf8");
		const workerFiles = fs.readdirSync(path.join(root, "dist", "workers")).filter((file) => file.endsWith(".js"));
		expect(source).toContain('esModule = embed "workers/app.js"');
		expect(source).not.toContain('name = "helper"');
		expect(workerFiles).toEqual(["app.js"]);

		const configPath = path.join(root, "dist", "workerd.capnp");
		const workerdProcess = spawn(workerdBin, ["serve", "--control-fd=3", configPath], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
		});
		onTestFinished(() => {
			terminateChildProcess(workerdProcess);
		});

		const port = await waitForListenPort(workerdProcess, "app");
		const response = await waitForResponse(`http://127.0.0.1:${port}/`);
		expect(await response.text()).toBe("helper");
	}, 15_000);

	it("rewrites emitted dynamic import chunks into worker modules", async () => {
		const root = createTempProjectRoot();
		fs.writeFileSync(
			path.join(root, "src", "index.ts"),
			"export default { async fetch() { const mod = await import('./lazy.ts'); return new Response(mod.default); } };\n",
		);
		fs.writeFileSync(path.join(root, "src", "lazy.ts"), "export default 'lazy';\n");
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
				"        modules: [",
				"          { name: 'main', esModule: embed('./src/index.ts') },",
				"          { name: 'lazy', esModule: embed('./src/lazy.ts') },",
				"        ],",
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

		const builder = await createBuilder({
			root,
			logLevel: "silent",
			plugins: [workerd()],
			build: {
				outDir: "dist",
				emptyOutDir: true,
			},
		});
		await builder.buildApp();

		const workerFiles = fs.readdirSync(path.join(root, "dist", "workers")).filter((file) => file.endsWith(".js"));
		expect(workerFiles).toHaveLength(2);
		expect(workerFiles).toContain("app.js");

		const source = fs.readFileSync(path.join(root, "dist", "workerd.capnp"), "utf8");
		expect(source).toContain('name = "main"');
		expect(source).toContain('esModule = embed "workers/app.js"');
		expect(source).not.toContain('name = "lazy"');

		for (const workerFile of workerFiles.filter((file) => file !== "app.js")) {
			expect(source).toContain(`name = "./${workerFile}"`);
			expect(source).toContain(`esModule = embed "workers/${workerFile}"`);
		}

		const configPath = path.join(root, "dist", "workerd.capnp");
		const workerdProcess = spawn(workerdBin, ["serve", "--control-fd=3", configPath], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
		});
		onTestFinished(() => {
			terminateChildProcess(workerdProcess);
		});

		const port = await waitForListenPort(workerdProcess, "app");
		const response = await waitForResponse(`http://127.0.0.1:${port}/`);
		expect(await response.text()).toBe("lazy");
	}, 15_000);

	it("throws when a worker service does not define a source-backed main module", async () => {
		const root = createTempProjectRoot();
		fs.writeFileSync(path.join(root, "src", "helper.ts"), "export default 'helper';\n");
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
				"        modules: [",
				"          { name: 'helper', esModule: embed('./src/helper.ts') },",
				"        ],",
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

		await expect(
			createBuilder({
				root,
				logLevel: "silent",
				plugins: [workerd()],
				build: {
					outDir: "dist",
					emptyOutDir: true,
				},
			}),
		).rejects.toThrowError(/must define exactly one source-backed `main` module/i);
	});

	it("throws when the config contains duplicate service names", async () => {
		const root = createTempProjectRoot();
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				"export default {",
				"  services: [",
				"    { name: 'app', network: { allow: ['public'] } },",
				"    { name: 'app', external: { address: 'example.com:443', tcp: {} } },",
				"  ],",
				"  sockets: [],",
				"};",
				"",
			].join("\n"),
		);

		await expect(
			createBuilder({
				root,
				logLevel: "silent",
				plugins: [workerd()],
				build: {
					outDir: "dist",
					emptyOutDir: true,
				},
			}),
		).rejects.toThrowError(/must not contain duplicate service names: `app`/i);
	});

	it("throws when service names normalize to the same build name", async () => {
		const root = createTempProjectRoot();
		fs.writeFileSync(
			path.join(root, "src", "one.ts"),
			"export default { async fetch() { return new Response('one'); } };\n",
		);
		fs.writeFileSync(
			path.join(root, "src", "two.ts"),
			"export default { async fetch() { return new Response('two'); } };\n",
		);
		fs.writeFileSync(
			path.join(root, "workerd.config.ts"),
			[
				`import { embed } from ${syntaxModulePath};`,
				"",
				"export default {",
				"  services: [",
				"    { name: 'foo-bar', worker: { modules: [{ name: 'main', esModule: embed('./src/one.ts') }], compatibilityDate: '2025-08-01' } },",
				"    { name: 'foo/bar', worker: { modules: [{ name: 'main', esModule: embed('./src/two.ts') }], compatibilityDate: '2025-08-01' } },",
				"  ],",
				"  sockets: [",
				"    { name: 'one', address: '*:0', http: {}, service: 'foo-bar' },",
				"    { name: 'two', address: '*:0', http: {}, service: 'foo/bar' },",
				"  ],",
				"};",
				"",
			].join("\n"),
		);

		await expect(
			createBuilder({
				root,
				logLevel: "silent",
				plugins: [workerd()],
				build: {
					outDir: "dist",
					emptyOutDir: true,
				},
			}),
		).rejects.toThrowError(/normalizes to the same build name as another service: `foo_bar`/i);
	});

	it("prefers worker-specific conditional exports when bundling workers", async () => {
		const root = createTempProjectRoot();
		const packageRoot = path.join(root, "node_modules", "conditional-worker-package");
		fs.mkdirSync(packageRoot, { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, "package.json"),
			JSON.stringify(
				{
					name: "conditional-worker-package",
					type: "module",
					exports: {
						".": {
							workerd: "./workerd.js",
							worker: "./worker.js",
							browser: "./browser.js",
							default: "./default.js",
						},
					},
				},
				null,
				2,
			),
		);
		fs.writeFileSync(path.join(packageRoot, "workerd.js"), "export default 'workerd';\n");
		fs.writeFileSync(path.join(packageRoot, "worker.js"), "export default 'worker';\n");
		fs.writeFileSync(path.join(packageRoot, "browser.js"), "export default 'browser';\n");
		fs.writeFileSync(path.join(packageRoot, "default.js"), "export default 'default';\n");
		fs.writeFileSync(
			path.join(root, "src", "index.ts"),
			"import branch from 'conditional-worker-package'; export default { async fetch() { return new Response(branch); } };\n",
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

		const builder = await createBuilder({
			root,
			logLevel: "silent",
			plugins: [workerd()],
			build: {
				outDir: "dist",
				emptyOutDir: true,
			},
		});
		await builder.buildApp();

		const configPath = path.join(root, "dist", "workerd.capnp");
		const workerdProcess = spawn(workerdBin, ["serve", "--control-fd=3", configPath], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
		});
		onTestFinished(() => {
			terminateChildProcess(workerdProcess);
		});

		const port = await waitForListenPort(workerdProcess, "app");
		const response = await waitForResponse(`http://127.0.0.1:${port}/`);
		expect(await response.text()).toBe("workerd");
	});

	it("prefers production conditional exports in production mode", async () => {
		const root = createTempProjectRoot();
		const packageRoot = path.join(root, "node_modules", "conditional-production-package");
		fs.mkdirSync(packageRoot, { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, "package.json"),
			JSON.stringify(
				{
					name: "conditional-production-package",
					type: "module",
					exports: {
						".": {
							production: "./production.js",
							default: "./default.js",
						},
					},
				},
				null,
				2,
			),
		);
		fs.writeFileSync(path.join(packageRoot, "production.js"), "export default 'production';\n");
		fs.writeFileSync(path.join(packageRoot, "default.js"), "export default 'default';\n");
		fs.writeFileSync(
			path.join(root, "src", "index.ts"),
			"import branch from 'conditional-production-package'; export default { async fetch() { return new Response(branch); } };\n",
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

		const builder = await createBuilder({
			root,
			mode: "production",
			logLevel: "silent",
			plugins: [workerd()],
			build: {
				outDir: "dist",
				emptyOutDir: true,
			},
		});
		await builder.buildApp();

		const configPath = path.join(root, "dist", "workerd.capnp");
		const workerdProcess = spawn(workerdBin, ["serve", "--control-fd=3", configPath], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
		});
		onTestFinished(() => {
			terminateChildProcess(workerdProcess);
		});

		const port = await waitForListenPort(workerdProcess, "app");
		const response = await waitForResponse(`http://127.0.0.1:${port}/`);
		expect(await response.text()).toBe("production");
	});
});

function createTempProjectRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vite-plugin-workerd-"));
	onTestFinished(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "src", "index.ts"),
		"export default { async fetch() { return new Response('ok'); } };\n",
	);

	return root;
}

async function waitForResponse(url: string): Promise<Response> {
	const startedAt = Date.now();
	let lastError: unknown;

	while (Date.now() - startedAt < 10_000) {
		try {
			return await fetch(url);
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	throw new Error(`Timed out waiting for workerd to respond at ${url}: ${String(lastError)}`);
}

async function waitForListenPort(
	child: ChildProcess,
	socketName: string,
): Promise<number> {
	const controlStream = child.stdio[3];
	if (!controlStream || typeof controlStream === "number") {
		throw new Error("workerd control stream was not available.");
	}
	const controlReadable = controlStream;

	return await new Promise((resolve, reject) => {
		let buffer = "";
		let stderr = "";

		const onData = (chunk: string | Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.trim()) {
					continue;
				}

				const message = JSON.parse(line) as {
					event?: string;
					socket?: string;
					port?: number;
				};

				if (message.event === "listen" && message.socket === socketName) {
					cleanup();
					resolve(message.port ?? 0);
				}
			}
		};

		const onStderr = (chunk: string | Buffer) => {
			stderr += chunk.toString();
		};

		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			reject(
				new Error(
					`workerd exited before reporting a listening port (code: ${String(code)}, signal: ${String(signal)}). ${stderr}`,
				),
			);
		};

		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for workerd to report the ${socketName} port. ${stderr}`));
		}, 10_000);

		const cleanup = () => {
			clearTimeout(timeout);
			controlReadable.off("data", onData);
			child.stderr?.off("data", onStderr);
			child.off("exit", onExit);
		};

		controlReadable.on("data", onData);
		child.stderr?.on("data", onStderr);
		child.on("exit", onExit);
	});
}

function terminateChildProcess(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}

	child.kill("SIGTERM");
}
