/// <reference types="@cloudflare/workers-types/experimental" />

import { DurableObject } from "cloudflare:workers";
import {
	ModuleRunner,
	ssrModuleExportsKey,
} from "vite/module-runner";

import {
	CONTROL_SERVICE_BINDING,
	INVALIDATE_WORKER_CODE_EVENT,
	INIT_PATH,
	RESOLVE_WORKER_CODE_EVENT,
	RESOLVE_WORKER_CODE_RESULT_EVENT,
	type ResolveWorkerCodeResult,
	RUNNER_OBJECT_BINDING,
	RUNNER_OBJECT_ID,
	UNSAFE_EVAL_BINDING,
	VIRTUAL_WORKER_ENTRY,
	WORKER_CODE_PATH,
	type WorkerLoaderCodePayload,
	WORKER_LOADER_BINDING,
} from "./shared";
interface UnsafeEvalBinding {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
	eval(code: string, filename: string): Function;
}

interface RunnerEnv {
	[CONTROL_SERVICE_BINDING]?: { fetch(request: Request): Promise<Response> };
	[RUNNER_OBJECT_BINDING]?: DurableObjectNamespace;
	[UNSAFE_EVAL_BINDING]?: UnsafeEvalBinding;
	[WORKER_LOADER_BINDING]?: WorkerLoader;
	[key: string]: unknown;
}

interface WorkerRequestContext {
	props: unknown;
	passThroughOnException(): void;
	waitUntil(promise: Promise<unknown>): void;
}

interface PendingWorkerCodeRequest {
	resolve(code: WorkerLoaderCodePayload): void;
	reject(reason?: unknown): void;
	timeout: ReturnType<typeof setTimeout>;
}

interface HmrPayload {
	type?: string;
	event?: string;
}

const pendingWorkerCodeByService = new Map<string, Promise<WorkerLoaderCodePayload>>();
const cachedWorkerCodeByService = new Map<string, WorkerLoaderCodePayload>();
const workerCodeDirtyByService = new Map<string, boolean>();
const workerCodeCacheEpochByService = new Map<string, number>();

const INTERNAL_BINDING_NAMES = new Set([
	CONTROL_SERVICE_BINDING,
	RUNNER_OBJECT_BINDING,
	UNSAFE_EVAL_BINDING,
	WORKER_LOADER_BINDING,
]);

/**
 * Forwards an internal request to the singleton runner Durable Object.
 */
export async function forwardToRunnerObjectRequest(
	request: Request,
	env: RunnerEnv,
): Promise<Response> {
	if (!env[RUNNER_OBJECT_BINDING]) {
		throw new Error(`Expected ${JSON.stringify(RUNNER_OBJECT_BINDING)} to be defined for the control service.`);
	}

	const id = env[RUNNER_OBJECT_BINDING].idFromName(RUNNER_OBJECT_ID);
	const stub = env[RUNNER_OBJECT_BINDING].get(id);

	return stub.fetch(request);
}

/**
 * Forwards an internal request to the dedicated control service.
 */
export async function forwardToControlServiceRequest(
	request: Request,
	env: RunnerEnv,
): Promise<Response> {
	if (!env[CONTROL_SERVICE_BINDING]) {
		throw new Error(`Expected ${JSON.stringify(CONTROL_SERVICE_BINDING)} to be defined for a hot wrapper service.`);
	}

	return env[CONTROL_SERVICE_BINDING].fetch(request);
}

/**
 * Dispatches an ordinary request through the current workerLoader generation.
 */
export async function dispatchHotWorkerRequest(options: {
	request: Request;
	env: RunnerEnv;
	context: WorkerRequestContext;
	serviceName: string;
	entrypoint?: string;
}): Promise<Response> {
	const entrypoint = await getHotWorkerEntrypoint(
		options.env,
		options.context,
		options.serviceName,
		options.entrypoint,
		options.request.url,
	);

	return entrypoint.fetch(options.request);
}

/**
 * Dispatches a generic RPC method to the current hot worker entrypoint.
 */
export async function dispatchHotWorkerEntrypointRpc(options: {
	env: RunnerEnv;
	context: WorkerRequestContext;
	serviceName: string;
	entrypoint?: string;
	property: string;
	args: unknown[];
	requestUrl?: string;
}): Promise<unknown> {
	const entrypoint = await getHotWorkerEntrypoint(
		options.env,
		options.context,
		options.serviceName,
		options.entrypoint,
		options.requestUrl,
	);
	const value = Reflect.get(entrypoint, options.property);

	if (typeof value !== "function") {
		throw new TypeError(
			`The hot worker entrypoint ${JSON.stringify(options.entrypoint)} does not implement the method ${JSON.stringify(options.property)}.`,
		);
	}

	return await Reflect.apply(value, entrypoint, options.args);
}

/**
 * Singleton Durable Object that owns the Vite module runner and control-plane state.
 */
export class __VITE_RUNNER_OBJECT__ extends DurableObject<RunnerEnv> {
	#runner?: ModuleRunner;
	#webSocket?: WebSocket;
	#pendingWorkerCodeRequests = new Map<string, PendingWorkerCodeRequest>();

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (pathname === INIT_PATH) {
			return this.#initialize();
		}

		if (pathname === WORKER_CODE_PATH) {
			const serviceName = new URL(request.url).searchParams.get("service");
			if (!serviceName) {
				return new Response("Missing required \"service\" query parameter.", { status: 400 });
			}

			return Response.json(await this.#getWorkerCode(serviceName));
		}

		const runner = this.#runner;
		if (!runner) {
			return new Response("vite-plugin-workerd runner has not been initialized.", {
				status: 503,
			});
		}

		return dispatchRequest({
			runner,
			request,
			env: this.env,
			context: createRequestContext(this.ctx),
		});
	}

	async #initialize(): Promise<Response> {
		await this.#runner?.close();
		this.#webSocket?.close();
		this.#closePendingWorkerCodeRequests(new Error("vite-plugin-workerd runner was reinitialized."));
		invalidateWorkerCodeCache();

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		server.accept();

		this.#webSocket = server;
		this.#runner = createModuleRunner(
			this.env,
			server,
			(payload) => this.#handleTransportPayload(payload),
			(payload) => this.#handleCustomPayload(payload),
		);

		return new Response(null, {
			status: 101,
			webSocket: client,
		} as ResponseInit & { webSocket: WebSocket });
	}

	async #getWorkerCode(serviceName: string): Promise<WorkerLoaderCodePayload> {
		return await getCachedWorkerCode(serviceName, () => this.#requestWorkerCode(serviceName));
	}

	async #requestWorkerCode(serviceName: string): Promise<WorkerLoaderCodePayload> {
		const webSocket = this.#webSocket;
		if (!webSocket) {
			throw new Error("vite-plugin-workerd runner has not established its Vite transport yet.");
		}

		const requestId = crypto.randomUUID();

		return await new Promise<WorkerLoaderCodePayload>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#pendingWorkerCodeRequests.delete(requestId);
				reject(new Error("Timed out waiting for Vite to materialize the hot worker code."));
			}, 10_000);

			this.#pendingWorkerCodeRequests.set(requestId, {
				resolve,
				reject,
				timeout,
			});

			webSocket.send(JSON.stringify({
				type: "custom",
				event: RESOLVE_WORKER_CODE_EVENT,
				data: { requestId, serviceName },
			}));
		});
	}

	#handleTransportPayload(payload: unknown): void {
		if (shouldInvalidateWorkerCodeCache(payload)) {
			invalidateWorkerCodeCache();
		}
	}

	#handleCustomPayload(payload: unknown): boolean {
		if (isInvalidateWorkerCodePayload(payload)) {
			invalidateWorkerCodeCache();
			return true;
		}

		if (!isResolveWorkerCodeResultPayload(payload)) {
			return false;
		}

		const pending = this.#pendingWorkerCodeRequests.get(payload.data.requestId);
		if (!pending) {
			return true;
		}

		this.#pendingWorkerCodeRequests.delete(payload.data.requestId);
		clearTimeout(pending.timeout);

		if (payload.data.error) {
			pending.reject(new Error(payload.data.error));
			return true;
		}

		if (!payload.data.code) {
			pending.reject(new Error("Vite returned a worker-code response without a payload."));
			return true;
		}

		pending.resolve(payload.data.code);
		return true;
	}

	#closePendingWorkerCodeRequests(reason: Error): void {
		for (const [requestId, pending] of this.#pendingWorkerCodeRequests) {
			this.#pendingWorkerCodeRequests.delete(requestId);
			clearTimeout(pending.timeout);
			pending.reject(reason);
		}
	}
}

/**
 * Creates the runtime-side Vite module runner used by the singleton Durable Object.
 */
function createModuleRunner(
	env: RunnerEnv,
	webSocket: WebSocket,
	onTransportPayload: (payload: unknown) => void,
	onCustomPayload: (payload: unknown) => boolean,
): ModuleRunner {
	return new ModuleRunner(
		{
			hmr: true,
			sourcemapInterceptor: "prepareStackTrace",
			transport: {
				connect({ onMessage }) {
					webSocket.addEventListener("message", ({ data }) => {
						const payload = JSON.parse(decodeWebSocketData(data));
						onTransportPayload(payload);
						if (onCustomPayload(payload)) {
							return;
						}

						onMessage(payload);
					});

					onMessage({
						type: "custom",
						event: "vite:ws:connect",
						data: { webSocket },
					});
				},
				disconnect() {
					webSocket.close();
				},
				send(data) {
					webSocket.send(JSON.stringify(data));
				},
			},
		},
		{
			async runInlinedModule(context, transformed, module) {
				if (!env[UNSAFE_EVAL_BINDING]) {
					throw new Error(`Expected ${JSON.stringify(UNSAFE_EVAL_BINDING)} to be defined for the control service.`);
				}

				const code = `"use strict";async (${Object.keys(context).join(",")})=>{${transformed}\n}`;
				const fn = env[UNSAFE_EVAL_BINDING].eval(code, module.id);

				await fn(...Object.values(context));
				Object.seal(context[ssrModuleExportsKey]);
			},
			async runExternalModule(filepath) {
				const externalModule = await import(filepath);

				if (
					filepath === "cloudflare:workers" &&
					externalModule &&
					typeof externalModule === "object" &&
					"env" in externalModule
				) {
					const cloudflareWorkersModule = externalModule as Record<string, unknown> & {
						env: Record<string, unknown>;
					};

					return Object.seal({
						...cloudflareWorkersModule,
						env: stripInternalEnv(cloudflareWorkersModule.env),
					});
				}

				return externalModule;
			},
		},
	);
}

/**
 * Dispatches a request to the current default export of the virtual worker entry.
 */
async function dispatchRequest(options: {
	runner: ModuleRunner;
	request: Request;
	env: RunnerEnv;
	context: WorkerRequestContext;
}): Promise<Response> {
	const module = await options.runner.import<Record<string, unknown>>(VIRTUAL_WORKER_ENTRY);
	const userEnv = stripInternalEnv(options.env);
	const handler = module.default;

	if (handler && typeof handler === "object") {
		const maybeFetch = Reflect.get(handler, "fetch");
		if (typeof maybeFetch !== "function") {
			throw new TypeError(
				`Expected ${JSON.stringify(VIRTUAL_WORKER_ENTRY)} to export a default handler with a fetch() method.`,
			);
		}

		return await maybeFetch.call(handler, options.request, userEnv, options.context);
	}

	if (typeof handler === "function") {
		const Handler = handler as new (
			context: WorkerRequestContext,
			env: Record<string, unknown>,
		) => {
			fetch?: (request: Request) => Promise<Response> | Response;
		};
		const instance = new Handler(options.context, userEnv);
		if (typeof instance.fetch !== "function") {
			throw new TypeError(
				`Expected the default export of ${JSON.stringify(VIRTUAL_WORKER_ENTRY)} to define a fetch() method.`,
			);
		}

		return await instance.fetch(options.request);
	}

	throw new TypeError(
		`Expected ${JSON.stringify(VIRTUAL_WORKER_ENTRY)} to export a default handler object or class.`,
	);
}

/**
 * Fetches the current workerLoader payload from the runner control plane.
 */
async function fetchWorkerCodeFromRunner(
	request: Request,
	env: RunnerEnv,
	serviceName: string,
): Promise<WorkerLoaderCodePayload> {
	const workerCodeUrl = new URL(request.url);
	workerCodeUrl.pathname = WORKER_CODE_PATH;
	workerCodeUrl.search = "";
 	workerCodeUrl.searchParams.set("service", serviceName);

	const response = await forwardToControlServiceRequest(new Request(workerCodeUrl.toString()), env);
	if (!response.ok) {
		throw new Error(
			`vite-plugin-workerd runner returned ${String(response.status)} while resolving worker code.`,
		);
	}

	return await response.json() as WorkerLoaderCodePayload;
}

/**
 * Resolves the active hot worker entrypoint stub for either fetch or RPC forwarding.
 */
async function getHotWorkerEntrypoint(
	env: RunnerEnv,
	context: WorkerRequestContext,
	serviceName: string,
	entrypoint: string | undefined,
	requestUrl = "http://127.0.0.1/",
) {
	const code = await fetchWorkerCodeFromRunner(new Request(requestUrl), env, serviceName);
	if (!env[WORKER_LOADER_BINDING]) {
		throw new Error(`Expected ${JSON.stringify(WORKER_LOADER_BINDING)} to be defined for a hot wrapper service.`);
	}

	const worker = env[WORKER_LOADER_BINDING].get(code.generation, () => ({
		compatibilityDate: code.compatibilityDate,
		compatibilityFlags: code.compatibilityFlags,
		allowExperimental: code.allowExperimental,
		mainModule: code.mainModule,
		modules: code.modules,
		env: stripInternalEnv(env),
	}));
	const entrypointOptions = context.props === undefined
		? undefined
		: { props: context.props };

	return worker.getEntrypoint(entrypoint, entrypointOptions);
}
/**
 * Marks the shared active worker-code cache dirty.
 */
function invalidateWorkerCodeCache(): void {
	for (const serviceName of new Set([
		...cachedWorkerCodeByService.keys(),
		...pendingWorkerCodeByService.keys(),
		...workerCodeDirtyByService.keys(),
		...workerCodeCacheEpochByService.keys(),
	])) {
		workerCodeCacheEpochByService.set(serviceName, getWorkerCodeCacheEpoch(serviceName) + 1);
		workerCodeDirtyByService.set(serviceName, true);
		pendingWorkerCodeByService.delete(serviceName);
	}
}

/**
 * Returns the shared active worker-code payload, refreshing it only when invalidated.
 */
async function getCachedWorkerCode(
	serviceName: string,
	resolveFresh: () => Promise<WorkerLoaderCodePayload>,
): Promise<WorkerLoaderCodePayload> {
	if (!isWorkerCodeDirty(serviceName)) {
		const cachedWorkerCode = cachedWorkerCodeByService.get(serviceName);
		if (cachedWorkerCode) {
			return cachedWorkerCode;
		}
	}

	const pendingWorkerCode = pendingWorkerCodeByService.get(serviceName);
	if (pendingWorkerCode) {
		return await pendingWorkerCode;
	}

	const refreshEpoch = getWorkerCodeCacheEpoch(serviceName);
	const pending = (async () => {
		const code = await resolveFresh();
		if (refreshEpoch === getWorkerCodeCacheEpoch(serviceName)) {
			cachedWorkerCodeByService.set(serviceName, code);
			workerCodeDirtyByService.set(serviceName, false);
		}
		return code;
	})();

	pendingWorkerCodeByService.set(serviceName, pending);

	try {
		return await pending;
	} finally {
		if (pendingWorkerCodeByService.get(serviceName) === pending) {
			pendingWorkerCodeByService.delete(serviceName);
		}
	}
}

/**
 * Returns the current cache epoch for a worker service.
 */
function getWorkerCodeCacheEpoch(serviceName: string): number {
	return workerCodeCacheEpochByService.get(serviceName) ?? 0;
}

/**
 * Checks whether a worker service's cached payload is dirty.
 */
function isWorkerCodeDirty(serviceName: string): boolean {
	return workerCodeDirtyByService.get(serviceName) ?? true;
}

/**
 * Strips the runtime's internal bindings before exposing env to user code.
 */
function stripInternalEnv(env: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(env).filter(([name]) => !INTERNAL_BINDING_NAMES.has(name)),
	);
}

/**
 * Creates the closest request-context shim we can provide from a Durable Object request.
 */
function createRequestContext(state: DurableObjectState): WorkerRequestContext {
	return {
		props: undefined,
		passThroughOnException() {},
		waitUntil(promise) {
			state.waitUntil?.(promise);
		},
	};
}

/**
 * Checks whether a websocket payload is a worker-code response from Vite.
 */
function isResolveWorkerCodeResultPayload(payload: unknown): payload is {
	type: "custom";
	event: typeof RESOLVE_WORKER_CODE_RESULT_EVENT;
	data: ResolveWorkerCodeResult;
} {
	if (!payload || typeof payload !== "object") {
		return false;
	}

	const message = payload as Record<string, unknown>;
	if (
		message.type !== "custom" ||
		message.event !== RESOLVE_WORKER_CODE_RESULT_EVENT ||
		!message.data ||
		typeof message.data !== "object"
	) {
		return false;
	}

	return typeof (message.data as Record<string, unknown>).requestId === "string";
}

/**
 * Checks whether a websocket payload is an explicit worker-code invalidation event from Vite.
 */
function isInvalidateWorkerCodePayload(payload: unknown): payload is {
	type: "custom";
	event: typeof INVALIDATE_WORKER_CODE_EVENT;
} {
	if (!payload || typeof payload !== "object") {
		return false;
	}

	const message = payload as Record<string, unknown>;
	return message.type === "custom" && message.event === INVALIDATE_WORKER_CODE_EVENT;
}

/**
 * Decides whether an incoming Vite transport payload invalidates the cached workerLoader code.
 */
function shouldInvalidateWorkerCodeCache(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") {
		return false;
	}

	const message = payload as HmrPayload;
	if (message.type === "update" || message.type === "full-reload" || message.type === "prune" || message.type === "error") {
		return true;
	}

	return false;
}

/**
 * Normalizes workerd WebSocket message payloads into strings for JSON parsing.
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
