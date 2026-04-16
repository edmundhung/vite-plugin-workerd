import assert from "node:assert";

import * as vite from "vite";

import type { WorkerTarget } from "./build";
import { createWorkerOptimizeDepsOptions, createWorkerResolveOptions } from "./worker-environment";

interface WebSocketState {
	webSocket?: WebSocket;
	bufferedMessages?: string[];
	listening: boolean;
	attached: boolean;
	listeners: Map<string, Set<vite.HotChannelListener>>;
	onMessage?: (event: MessageEvent) => void;
}

const WORKER_LOADER_ENVIRONMENT_SUFFIX = "_loader";

/**
 * Dev environment backed by a single WebSocket connection to the workerd runner.
 */
export class WorkerdDevEnvironment extends vite.DevEnvironment {
	#state: WebSocketState;

	constructor(name: string, config: vite.ResolvedConfig) {
		const state: WebSocketState = {
			listening: false,
			attached: false,
			listeners: new Map(),
		};

		super(name, config, {
			hot: true,
			transport: createHotChannel(state),
		});

		this.#state = state;
	}

	async initRunner(controlUrl: string): Promise<void> {
		const webSocket = await openWebSocket(controlUrl);

		if (this.#state.webSocket) {
			detachWebSocket(this.#state);
			this.#state.webSocket.close();
		}

		this.#state.webSocket = webSocket;
		attachWebSocket(this.#state);
		flushBufferedMessages(this.#state);
	}
}

/**
 * Creates the Vite environment options used to evaluate the hot worker entry in dev.
 */
export function createWorkerdDevEnvironmentOptions(
	target: WorkerTarget,
): vite.EnvironmentOptions {
	return {
		consumer: "server",
		keepProcessEnv: true,
		resolve: createWorkerResolveOptions("development"),
		optimizeDeps: createWorkerOptimizeDepsOptions(target.entryPath),
		dev: {
			createEnvironment(name, config) {
				return new WorkerdDevEnvironment(name, config);
			},
		},
	};
}

/**
 * Returns the Vite environment name used to materialize workerLoader modules.
 */
export function getWorkerdLoaderEnvironmentName(target: WorkerTarget): string {
	return `${target.environmentName}${WORKER_LOADER_ENVIRONMENT_SUFFIX}`;
}

/**
 * Creates the non-HMR worker environment used to collect plain ESM transforms for workerLoader.
 */
export function createWorkerdLoaderEnvironmentOptions(
	target: WorkerTarget,
): vite.EnvironmentOptions {
	return {
		consumer: "server",
		keepProcessEnv: true,
		resolve: createWorkerResolveOptions("development"),
		optimizeDeps: {
			...createWorkerOptimizeDepsOptions(target.entryPath),
			noDiscovery: true,
			disabled: true,
		},
		dev: {
			moduleRunnerTransform: false,
			preTransformRequests: true,
		},
	};
}

/**
 * Creates the custom hot channel that bridges Vite and the workerd runner.
 */
function createHotChannel(state: WebSocketState): vite.HotChannel {
	const client: vite.HotChannelClient = {
		send(payload) {
			const webSocket = state.webSocket;
			assert(webSocket, "The runner WebSocket has not been initialized.");

			webSocket.send(JSON.stringify(payload));
		},
	};

	const onMessage = (event: MessageEvent) => {
		const payload = JSON.parse(decodeWebSocketData(event.data)) as vite.CustomPayload;
		const listeners = state.listeners.get(payload.event) ?? new Set();

		for (const listener of listeners) {
			listener(payload.data, client);
		}
	};

	state.onMessage = onMessage;

	return {
		skipFsCheck: true,
		send(payload) {
			const message = JSON.stringify(payload);
			const webSocket = state.webSocket;

			if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
				state.bufferedMessages ??= [];
				state.bufferedMessages.push(message);
				return;
			}

			webSocket.send(message);
		},
		on(event: string, listener: vite.HotChannelListener) {
			const listeners = state.listeners.get(event) ?? new Set();
			listeners.add(listener);
			state.listeners.set(event, listeners);
		},
		off(event: string, listener: vite.HotChannelListener) {
			state.listeners.get(event)?.delete(listener);
		},
		listen() {
			state.listening = true;
			attachWebSocket(state);
		},
		close() {
			state.listening = false;
			detachWebSocket(state);
			state.webSocket?.close();
			state.webSocket = undefined;
			state.bufferedMessages = undefined;
			state.listeners.clear();
		},
	};
}

/**
 * Opens the runner control WebSocket and waits for the handshake to complete.
 */
async function openWebSocket(url: string): Promise<WebSocket> {
	const webSocket = new WebSocket(url);

	await new Promise<void>((resolve, reject) => {
		const handleOpen = () => {
			cleanup();
			resolve();
		};

		const handleError = () => {
			cleanup();
			reject(new Error(`Failed to connect to workerd runner at ${url}.`));
		};

		const handleClose = () => {
			cleanup();
			reject(new Error(`workerd runner at ${url} closed before the connection was established.`));
		};

		const cleanup = () => {
			webSocket.removeEventListener("open", handleOpen);
			webSocket.removeEventListener("error", handleError);
			webSocket.removeEventListener("close", handleClose);
		};

		webSocket.addEventListener("open", handleOpen);
		webSocket.addEventListener("error", handleError);
		webSocket.addEventListener("close", handleClose);
	});

	return webSocket;
}

/**
 * Attaches the message listener when the environment is actively listening.
 */
function attachWebSocket(
	state: WebSocketState,
): void {
	if (!state.listening || state.attached || !state.webSocket || !state.onMessage) {
		return;
	}

	state.webSocket.addEventListener("message", state.onMessage);
	state.attached = true;
}

/**
 * Detaches the message listener from the current WebSocket.
 */
function detachWebSocket(
	state: WebSocketState,
): void {
	if (!state.attached || !state.webSocket || !state.onMessage) {
		return;
	}

	state.webSocket.removeEventListener("message", state.onMessage);
	state.attached = false;
}

/**
 * Flushes any Vite messages that were buffered before the runner connected.
 */
function flushBufferedMessages(state: WebSocketState): void {
	const webSocket = state.webSocket;
	if (!webSocket || webSocket.readyState !== WebSocket.OPEN || !state.bufferedMessages) {
		return;
	}

	for (const message of state.bufferedMessages) {
		webSocket.send(message);
	}

	state.bufferedMessages = undefined;
}

/**
 * Normalizes Node and workerd WebSocket message payloads into JSON strings.
 */
function decodeWebSocketData(data: unknown): string {
	if (typeof data === "string") {
		return data;
	}

	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(new Uint8Array(data));
	}

	if (ArrayBuffer.isView(data)) {
		return new TextDecoder().decode(data);
	}

	return String(data);
}
