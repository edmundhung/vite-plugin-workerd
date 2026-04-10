import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { describe, expect, it, onTestFinished } from "vitest";
import { build } from "vite";

import { embed, workerd } from "../src/index";

const workerdBin = path.resolve(process.cwd(), "node_modules", ".bin", "workerd");
const syntaxModulePath = JSON.stringify(path.resolve(process.cwd(), "src", "syntax.ts"));

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
				"        modules: [{ name: 'main', esModule: embed('./src/index.js') }],",
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

		await build({
			root,
			logLevel: "silent",
			plugins: [workerd()],
			build: {
				lib: {
					entry: path.join(root, "src", "index.js"),
					formats: ["es"],
					fileName: "app",
				},
				outDir: "dist",
				emptyOutDir: true,
			},
		});

		const configPath = path.join(root, "dist", "workerd.capnp");
		const source = fs.readFileSync(configPath, "utf8");

		expect(source).toContain('const config :Workerd.Config =');
		expect(source).toContain('esModule = embed "../src/index.js"');
		expect(source).toContain('address = "*:0"');

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

	it("loads a custom configFile and emits a nested output path", async () => {
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
				"        modules: [{ name: 'main', esModule: embed('../src/index.js') }],",
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

		await build({
			root,
			logLevel: "silent",
			plugins: [
				workerd({
					configFile: "configs/workerd.custom.ts",
					output: "runtime/server.capnp",
				}),
			],
			build: {
				lib: {
					entry: path.join(root, "src", "index.js"),
					formats: ["es"],
					fileName: "app",
				},
				outDir: "dist",
				emptyOutDir: true,
			},
		});

		const configPath = path.join(root, "dist", "runtime", "server.capnp");
		const source = fs.readFileSync(configPath, "utf8");

		expect(source).toContain('esModule = embed "../../src/index.js"');
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
				"        modules: [{ name: 'main', esModule: embed('./src/index.js') }],",
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

		await build({
			root,
			mode: "production",
			logLevel: "silent",
			plugins: [workerd()],
			build: {
				lib: {
					entry: path.join(root, "src", "index.js"),
					formats: ["es"],
					fileName: "app",
				},
				outDir: "dist",
				emptyOutDir: true,
			},
		});

		const configPath = path.join(root, "dist", "workerd.capnp");
		const source = fs.readFileSync(configPath, "utf8");

		expect(source).toContain('compatibilityDate = "2025-08-01"');
		expect(source).toContain('esModule = embed "../src/index.js"');
	});

	it("throws a clear error when no default config file exists", async () => {
		const root = createTempProjectRoot();

		await expect(
			build({
				root,
				logLevel: "silent",
				plugins: [workerd()],
				build: {
					lib: {
						entry: path.join(root, "src", "index.js"),
						formats: ["es"],
						fileName: "app",
					},
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
			build({
				root,
				logLevel: "silent",
				plugins: [workerd()],
				build: {
					lib: {
						entry: path.join(root, "src", "index.js"),
						formats: ["es"],
						fileName: "app",
					},
					outDir: "dist",
					emptyOutDir: true,
				},
			}),
		).rejects.toThrowError(/workerd config must include a `services` array\./);
	});

	it("resolves inline config paths from viteConfig.root", async () => {
		const root = createTempProjectRoot();

		await build({
			root,
			logLevel: "silent",
			plugins: [
				workerd({
					output: "runtime/server.capnp",
					config: {
						services: [
							{
								name: "app",
								worker: {
									modules: [{ name: "main", esModule: embed("./src/index.js") }],
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
				lib: {
					entry: path.join(root, "src", "index.js"),
					formats: ["es"],
					fileName: "app",
				},
				outDir: "dist",
				emptyOutDir: true,
			},
		});

		const configPath = path.join(root, "dist", "runtime", "server.capnp");
		const source = fs.readFileSync(configPath, "utf8");

		expect(source).toContain('esModule = embed "../../src/index.js"');
		expect(source).toContain('address = "*:8787"');
	});

	it("supports inline callback config", async () => {
		const root = createTempProjectRoot();

		await build({
			root,
			mode: "production",
			logLevel: "silent",
			plugins: [
				workerd({
					config: ({ mode }) => ({
						services: [
							{
								name: "app",
								worker: {
									modules: [{ name: "main", esModule: embed("./src/index.js") }],
									compatibilityDate: mode === "production" ? "2025-08-01" : "2025-08-02",
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
				lib: {
					entry: path.join(root, "src", "index.js"),
					formats: ["es"],
					fileName: "app",
				},
				outDir: "dist",
				emptyOutDir: true,
			},
		});

		const configPath = path.join(root, "dist", "workerd.capnp");
		const source = fs.readFileSync(configPath, "utf8");

		expect(source).toContain('compatibilityDate = "2025-08-01"');
		expect(source).toContain('esModule = embed "../src/index.js"');
	});
});

function createTempProjectRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vite-plugin-workerd-"));
	onTestFinished(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "src", "index.js"),
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
