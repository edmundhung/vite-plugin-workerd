import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type { Logger } from "vite";

import type { SocketRoute } from "../config/dev";

const WORKERD_CONTROL_FD = 3;

interface RunningWorkerd {
	child: ChildProcess;
	ports: Map<string, number>;
}

export interface WorkerdDevRuntime {
	restart(): Promise<void>;
	close(): Promise<void>;
	resolve(socketName: string): { protocol: "http" | "https"; port: number } | undefined;
	getPid(): number | undefined;
}

/**
 * Creates the persistent workerd child-process manager used during dev.
 */
export function createWorkerdRuntime(options: {
	root: string;
	configPath: string;
	routes: Map<string, SocketRoute>;
	logger: Logger;
}): WorkerdDevRuntime {
	let activeRuntime: RunningWorkerd | undefined;
	let restartChain = Promise.resolve();

	const restart = async () => {
		restartChain = restartChain.catch(() => {}).then(async () => {
			const nextRuntime = await startWorkerdProcess({
				root: options.root,
				configPath: options.configPath,
				routes: options.routes,
				logger: options.logger,
			});
			const previousRuntime = activeRuntime;
			activeRuntime = nextRuntime;

			await stopWorkerdProcess(previousRuntime);
		});

		return restartChain;
	};

	return {
		restart,
		close: async () => {
			await restartChain.catch(() => {});
			await stopWorkerdProcess(activeRuntime);
			activeRuntime = undefined;
		},
		resolve(socketName) {
			const route = options.routes.get(socketName);
			const port = activeRuntime?.ports.get(socketName);
			if (!route || port === undefined) {
				return undefined;
			}

			return {
				protocol: route.protocol,
				port,
			};
		},
		getPid() {
			return activeRuntime?.child.pid;
		},
	};
}

/**
 * Resolves the local workerd binary if present, otherwise falls back to PATH lookup.
 */
function resolveWorkerdBinary(root: string): string {
	const localBinary = path.join(
		root,
		"node_modules",
		".bin",
		process.platform === "win32" ? "workerd.cmd" : "workerd",
	);

	return fs.existsSync(localBinary) ? localBinary : "workerd";
}

/**
 * Spawns workerd and waits until every configured socket has reported its assigned port.
 */
async function startWorkerdProcess(options: {
	root: string;
	configPath: string;
	routes: Map<string, SocketRoute>;
	logger: Logger;
}): Promise<RunningWorkerd> {
	const child = spawn(
		resolveWorkerdBinary(options.root),
		["serve", "--experimental", `--control-fd=${WORKERD_CONTROL_FD}`, options.configPath],
		{
			cwd: options.root,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
		},
	);
	const ports = await waitForSocketPorts(child, [...options.routes.keys()]);

	child.on("exit", (code, signal) => {
		if (code === 0 || signal === "SIGTERM") {
			return;
		}

		options.logger.error(
			`workerd exited unexpectedly (code: ${String(code)}, signal: ${String(signal)}).`,
		);
	});

	return {
		child,
		ports,
	};
}

/**
 * Stops a running workerd child process.
 */
async function stopWorkerdProcess(runtime: RunningWorkerd | undefined): Promise<void> {
	if (!runtime) {
		return;
	}

	const { child } = runtime;
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}

	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
		}, 2_000);

		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});

		child.kill("SIGTERM");
	});
}

/**
 * Waits until workerd reports the bound port for every configured socket.
 */
async function waitForSocketPorts(
	child: ChildProcess,
	expectedSocketNames: string[],
): Promise<Map<string, number>> {
	const controlStream = child.stdio[WORKERD_CONTROL_FD];
	if (!controlStream || typeof controlStream === "number") {
		throw new Error("workerd control stream was not available.");
	}

	return await new Promise((resolve, reject) => {
		const pendingSocketNames = new Set(expectedSocketNames);
		const ports = new Map<string, number>();
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

				if (message.event !== "listen" || !message.socket || message.port === undefined) {
					continue;
				}

				if (!pendingSocketNames.has(message.socket)) {
					continue;
				}

				ports.set(message.socket, message.port);
				pendingSocketNames.delete(message.socket);

				if (pendingSocketNames.size === 0) {
					cleanup();
					resolve(ports);
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
					`workerd exited before reporting its listening ports (code: ${String(code)}, signal: ${String(signal)}). ${stderr}`,
				),
			);
		};

		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for workerd to report its listening ports. ${stderr}`));
		}, 10_000);

		const cleanup = () => {
			clearTimeout(timeout);
			controlStream.off("data", onData);
			child.stderr?.off("data", onStderr);
			child.off("exit", onExit);
		};

		controlStream.on("data", onData);
		child.stderr?.on("data", onStderr);
		child.on("exit", onExit);
	});
}
