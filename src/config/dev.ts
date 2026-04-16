import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build as viteBuild } from "vite";

import {
	type WorkerTarget,
	type WorkerdBuildContext,
	writeSerializedConfig,
} from "../plugins/build";
import { prepareConfigForSerialization, serializeConfig } from "./serialize";
import {
	CONTROL_SERVICE_BINDING,
	CONTROL_SERVICE_NAME,
	CONTROL_SOCKET_NAME,
	INIT_PATH,
	RUNNER_OBJECT_CLASS_NAME,
	RUNNER_OBJECT_BINDING,
	UNSAFE_EVAL_BINDING,
	WORKER_LOADER_BINDING,
} from "../runtime/shared";
import type {
	ServiceReferenceConfig,
	WorkerConfig,
	WorkerdConfig,
	WorkerdSocket,
	WorkerdService,
} from "./workerd";
import { WORKER_EXTERNAL_IDS, createWorkerResolveOptions } from "../plugins/worker-environment";

const INTERNAL_WORKERD_HOST = "127.0.0.1";
const WORKERD_DEV_DIRECTORY = "workerd";

export interface SocketRoute {
	name: string;
	protocol: "http" | "https";
}

export interface ResolvedSocketRoutes {
	defaultSocketName: string;
	routes: Map<string, SocketRoute>;
}

/**
 * Resolves the cache directory used for dev-time worker artifacts.
 */
export function resolveDevOutputDirectory(root: string, cacheDir: string): string {
	return path.resolve(root, cacheDir, WORKERD_DEV_DIRECTORY);
}

/**
 * Picks the first worker behind the default socket when possible, otherwise the first worker service.
 */
export function resolveHotWorkerTarget(
	context: WorkerdBuildContext,
	defaultSocket: string | undefined,
): WorkerTarget {
	if (context.workerTargets.length === 0) {
		throw new Error("vite dev requires at least one worker service in the loaded workerd config.");
	}

	const defaultSocketName = defaultSocket ?? context.config.sockets[0]?.name;
	const defaultSocketService = defaultSocketName
		? getServiceNameFromReference(
			context.config.sockets.find((socket) => socket.name === defaultSocketName)?.service,
		)
		: undefined;

	if (defaultSocketService) {
		const target = context.workerTargets.find((workerTarget) => workerTarget.serviceName === defaultSocketService);
		if (target) {
			return target;
		}
	}

	return context.workerTargets[0];
}

/**
 * Loads the stable runtime helper worker source used by workerd in dev.
 */
export async function loadRunnerWorkerModuleSource(): Promise<string> {
	const entryPath = resolveRunnerWorkerEntryPath();
	const buildResult = await viteBuild({
		appType: "custom",
		configFile: false,
		logLevel: "silent",
		resolve: createWorkerResolveOptions("development"),
		build: {
			ssr: true,
			target: "esnext",
			emptyOutDir: false,
			copyPublicDir: false,
			write: false,
			rollupOptions: {
				input: entryPath,
				external: [...WORKER_EXTERNAL_IDS],
				output: {
					format: "es",
					entryFileNames: "runner-worker.js",
					inlineDynamicImports: true,
				},
			},
		},
	});

	return extractEntryChunkSource(buildResult);
}

/**
 * Resolves the helper entry used for in-memory rebundling of the runtime worker.
 */
function resolveRunnerWorkerEntryPath(): string {
	const candidatePaths = [
		fileURLToPath(new URL("./runtime/runner-worker.js", import.meta.url)),
		fileURLToPath(new URL("../../dist/runtime/runner-worker.js", import.meta.url)),
		fileURLToPath(new URL("../runtime/runner-worker.ts", import.meta.url)),
	];

	for (const candidatePath of candidatePaths) {
		if (fs.existsSync(candidatePath)) {
			return candidatePath;
		}
	}

	throw new Error("Could not resolve the runner-worker helper entry path.");
}

/**
 * Extracts the entry chunk source from a `vite build({ write: false })` result.
 */
function extractEntryChunkSource(buildResult: unknown): string {
	const outputs = Array.isArray(buildResult) ? buildResult : [buildResult];

	for (const output of outputs) {
		if (!output || typeof output !== "object" || !("output" in output) || !Array.isArray(output.output)) {
			continue;
		}

		for (const chunk of output.output) {
			if (
				chunk &&
				typeof chunk === "object" &&
				"type" in chunk &&
				chunk.type === "chunk" &&
				"isEntry" in chunk &&
				chunk.isEntry &&
				"code" in chunk &&
				typeof chunk.code === "string"
			) {
				return chunk.code;
			}
		}
	}

	throw new Error("Could not extract the bundled runner-worker entry chunk source.");
}

/**
 * Creates the generated wrapper module source that preserves the current service-designator entrypoints.
 */
export function createDevWrapperModuleSource(options: {
	serviceName: string;
	runtimeModuleSpecifier: string;
	entrypointNames: string[];
	}): string {
	const entrypointExports = options.entrypointNames.map((entrypointName) => {
		assertValidEntrypointName(entrypointName);

		return [
			`export class ${entrypointName} extends WorkerEntrypoint {`,
			`  constructor(ctx, env) {`,
			`    super(ctx, env);`,
			`    return createHotEntrypointProxy(this, ${JSON.stringify(options.serviceName)}, ${JSON.stringify(entrypointName)});`,
			`  }`,
			"",
			`  fetch(request) {`,
			`    return dispatchHotWorkerRequest({ request, env: this.env, context: this.ctx, serviceName: ${JSON.stringify(options.serviceName)}, entrypoint: ${JSON.stringify(entrypointName)} }).catch((error) => new Response(String(error?.stack ?? error?.message ?? error), { status: 500 }));`,
			`  }`,
			`}`,
		].join("\n");
	});

	return [
		`import { WorkerEntrypoint } from ${JSON.stringify("cloudflare:workers")};`,
		`import { dispatchHotWorkerEntrypointRpc, dispatchHotWorkerRequest, forwardToControlServiceRequest } from ${JSON.stringify(options.runtimeModuleSpecifier)};`,
		"",
		"function createHotEntrypointProxy(target, serviceName, entrypoint) {",
		"  return new Proxy(target, {",
		"    get(instance, prop, receiver) {",
		"      if (typeof prop !== 'string' || Reflect.has(instance, prop)) {",
		"        return Reflect.get(instance, prop, receiver);",
		"      }",
		"",
		"      return (...args) => dispatchHotWorkerEntrypointRpc({",
		"        env: instance.env,",
		"        context: instance.ctx,",
		"        serviceName,",
		"        entrypoint,",
		"        property: prop,",
		"        args,",
		"      });",
		"    },",
		"  });",
		"}",
		"",
		"export default class extends WorkerEntrypoint {",
		"  constructor(ctx, env) {",
		"    super(ctx, env);",
		`    return createHotEntrypointProxy(this, ${JSON.stringify(options.serviceName)}, undefined);`,
		"  }",
		"",
		"  fetch(request) {",
		`    if (new URL(request.url).pathname === ${JSON.stringify(INIT_PATH)}) {`,
		"      return forwardToControlServiceRequest(request, this.env);",
		"    }",
		"",
		`    return dispatchHotWorkerRequest({ request, env: this.env, context: this.ctx, serviceName: ${JSON.stringify(options.serviceName)} }).catch((error) => new Response(String(error?.stack ?? error?.message ?? error), { status: 500 }));`,
		"  }",
		"}",
		...(entrypointExports.length === 0 ? [] : ["", ...entrypointExports]),
		"",
	].join("\n");
}

/**
 * Creates the dedicated internal control service module source used to host the runner DO.
 */
export function createDevControlModuleSource(options: {
	runtimeModuleSpecifier: string;
}): string {
	return [
		`import { forwardToRunnerObjectRequest, __VITE_RUNNER_OBJECT__ } from ${JSON.stringify(options.runtimeModuleSpecifier)};`,
		"",
		"export { __VITE_RUNNER_OBJECT__ };",
		"",
		"export default {",
		"  fetch(request, env) {",
		"    return forwardToRunnerObjectRequest(request, env);",
		"  },",
		"};",
		"",
	].join("\n");
}

/**
 * Builds the dev-time workerd config by keeping all workers static except the hot target.
 */
export function createDevConfig(options: {
	context: WorkerdBuildContext;
	controlTarget: WorkerTarget;
	runtimeModuleSource: string;
	controlModuleSource: string;
	wrapperModuleSourcesByService: Map<string, string>;
}): { config: WorkerdConfig; controlSocketName: string } {
	assertReservedNamesAvailable(options.context.config);

	return {
		config: {
			...options.context.config,
			services: [
				...options.context.config.services.map((service) => {
					if (!("worker" in service)) {
						return service;
					}

					assertInternalNameAvailability(service.worker);
					if ((service.worker.durableObjectNamespaces?.length ?? 0) > 0) {
						throw new Error(
							`vite dev hot reload for ${JSON.stringify(service.name)} does not support Durable Objects yet.`,
						);
					}

					const wrapperModuleSource = options.wrapperModuleSourcesByService.get(service.name);
					if (!wrapperModuleSource) {
						throw new Error(`Expected a generated wrapper module for service ${JSON.stringify(service.name)}.`);
					}

					return {
						...service,
						worker: createDynamicWorkerConfig(
							service.name,
							service.worker,
							wrapperModuleSource,
							options.runtimeModuleSource,
						),
					};
				}),
				createControlServiceConfig(
					options.controlTarget.serviceName,
					getWorkerConfigForService(options.context.config.services, options.controlTarget.serviceName),
					options.controlModuleSource,
					options.runtimeModuleSource,
				),
			],
			sockets: [
				...options.context.config.sockets.map((socket) => ({
					...socket,
					address: `${INTERNAL_WORKERD_HOST}:0`,
				})),
				{
					name: CONTROL_SOCKET_NAME,
					address: `${INTERNAL_WORKERD_HOST}:0`,
					http: {},
					service: CONTROL_SERVICE_NAME,
				} satisfies WorkerdSocket,
			],
		},
		controlSocketName: CONTROL_SOCKET_NAME,
	};
}

/**
 * Writes the generated workerd config used by the active dev runtime.
 */
export function writeDevConfig(outputPath: string, config: WorkerdConfig): void {
	const model = prepareConfigForSerialization(config, { outputPath });
	const source = serializeConfig(model);

	writeSerializedConfig({
		outputPath,
		source,
	});
}

/**
 * Resolves the default socket and public routing table exposed through Vite.
 */
export function resolveSocketRoutes(
	config: WorkerdConfig,
	defaultSocket: string | undefined,
): ResolvedSocketRoutes {
	if (config.sockets.length === 0) {
		throw new Error("workerd config must define at least one socket for vite dev.");
	}

	const routes = new Map<string, SocketRoute>(
		config.sockets.map((socket) => [
			socket.name,
			{
				name: socket.name,
				protocol: socket.https ? "https" : "http",
			},
		]),
	);
	const defaultSocketName = defaultSocket ?? config.sockets[0].name;

	if (!routes.has(defaultSocketName)) {
		throw new Error(`Default socket ${JSON.stringify(defaultSocketName)} does not exist in the loaded workerd config.`);
	}

	return {
		defaultSocketName,
		routes,
	};
}

/**
 * Replaces the hot worker's config with the stable runtime wrapper used during dev.
 */
function createDynamicWorkerConfig(
	serviceName: string,
	baseWorker: WorkerConfig,
	wrapperModuleSource: string,
	runtimeModuleSource: string,
): WorkerConfig {
	return {
		...baseWorker,
		compatibilityFlags: [...new Set([...(baseWorker.compatibilityFlags ?? []), "experimental"])],
		modules: createWrapperModules(wrapperModuleSource, runtimeModuleSource),
		bindings: [
			...(baseWorker.bindings ?? []),
			{ name: WORKER_LOADER_BINDING, workerLoader: { id: `vite-plugin-workerd:${serviceName}` } },
			{ name: CONTROL_SERVICE_BINDING, service: CONTROL_SERVICE_NAME },
		],
	};
}

/**
 * Creates the dedicated internal control service config.
 */
function createControlServiceConfig(
	controlTargetServiceName: string,
	baseWorker: WorkerConfig,
	controlModuleSource: string,
	runtimeModuleSource: string,
): WorkerdService {
	assertInternalNameAvailability(baseWorker);

	return {
		name: CONTROL_SERVICE_NAME,
		worker: {
			compatibilityDate: baseWorker.compatibilityDate,
			compatibilityFlags: [...new Set([...(baseWorker.compatibilityFlags ?? []), "experimental"])],
			modules: createWrapperModules(controlModuleSource, runtimeModuleSource),
			bindings: [
				{ name: RUNNER_OBJECT_BINDING, durableObjectNamespace: RUNNER_OBJECT_CLASS_NAME },
				{ name: UNSAFE_EVAL_BINDING, unsafeEval: true },
			],
			durableObjectNamespaces: [
				{
					className: RUNNER_OBJECT_CLASS_NAME,
					uniqueKey: `vite-plugin-workerd:runner-control:${controlTargetServiceName}`,
					preventEviction: true,
				},
			],
			durableObjectStorage: { inMemory: true },
		},
	};
}

/**
 * Builds the module list shared by wrapper-based dev services.
 */
function createWrapperModules(wrapperModuleSource: string, runtimeModuleSource: string): WorkerConfig["modules"] {
	const runtimeModuleName = "./runner-worker.js";

	return [
		{
			name: "main",
			esModule: wrapperModuleSource,
		},
		{
			name: runtimeModuleName,
			esModule: runtimeModuleSource,
		},
	];
}

/**
 * Validates that the hot worker does not already use the runtime's reserved internal names.
 */
function assertInternalNameAvailability(worker: WorkerConfig): void {
	for (const binding of worker.bindings ?? []) {
		if (
			binding.name === CONTROL_SERVICE_BINDING ||
			binding.name === RUNNER_OBJECT_BINDING ||
			binding.name === UNSAFE_EVAL_BINDING ||
			binding.name === WORKER_LOADER_BINDING
		) {
			throw new Error(`Binding name ${JSON.stringify(binding.name)} is reserved for vite dev internals.`);
		}
	}

	for (const namespace of worker.durableObjectNamespaces ?? []) {
		if (namespace.className === RUNNER_OBJECT_CLASS_NAME) {
			throw new Error(
				`Durable Object class name ${JSON.stringify(RUNNER_OBJECT_CLASS_NAME)} is reserved for vite dev internals.`,
			);
		}
	}
}

/**
 * Ensures the generated internal socket and service names do not conflict with user config.
 */
function assertReservedNamesAvailable(config: WorkerdConfig): void {
	if (config.sockets.some((socket) => socket.name === CONTROL_SOCKET_NAME)) {
		throw new Error(`Socket name ${JSON.stringify(CONTROL_SOCKET_NAME)} is reserved for vite dev internals.`);
	}

	if (config.services.some((service) => service.name === CONTROL_SERVICE_NAME)) {
		throw new Error(`Service name ${JSON.stringify(CONTROL_SERVICE_NAME)} is reserved for vite dev internals.`);
	}
}

/**
 * Looks up the worker config for a specific service name.
 */
function getWorkerConfigForService(services: WorkerdService[], serviceName: string): WorkerConfig {
	const service = services.find(
		(candidate): candidate is Extract<WorkerdService, { worker: WorkerConfig }> =>
			candidate.name === serviceName && "worker" in candidate,
	);
	if (!service) {
		throw new Error(`Could not find worker service ${JSON.stringify(serviceName)} in the loaded workerd config.`);
	}

	return service.worker;
}

/**
 * Extracts the target service name from a raw service reference.
 */
function getServiceNameFromReference(service: ServiceReferenceConfig | undefined): string | undefined {
	if (!service) {
		return undefined;
	}

	return typeof service === "string" ? service : service.name;
}

/**
 * Collects every config-level named entrypoint that targets the hot service.
 */
export function collectReferencedEntrypoints(
	config: WorkerdConfig,
	serviceName: string,
): string[] {
	const entrypoints = new Set<string>();

	for (const socket of config.sockets) {
		addReferencedEntrypoint(entrypoints, socket.service, serviceName);
	}

	for (const service of config.services) {
		if (!("worker" in service)) {
			continue;
		}

		for (const binding of service.worker.bindings ?? []) {
			if ("service" in binding) {
				addReferencedEntrypoint(entrypoints, binding.service, serviceName);
			}
		}

		addReferencedEntrypoint(entrypoints, service.worker.globalOutbound, serviceName);
		addReferencedEntrypoint(entrypoints, service.worker.cacheApiOutbound, serviceName);

		for (const target of service.worker.tails ?? []) {
			addReferencedEntrypoint(entrypoints, target, serviceName);
		}

		for (const target of service.worker.streamingTails ?? []) {
			addReferencedEntrypoint(entrypoints, target, serviceName);
		}
	}

	return [...entrypoints].sort();
}

/**
 * Records a referenced named entrypoint when a service designator targets the hot service.
 */
function addReferencedEntrypoint(
	entrypoints: Set<string>,
	serviceReference: ServiceReferenceConfig | undefined,
	serviceName: string,
): void {
	if (!serviceReference || typeof serviceReference === "string") {
		return;
	}

	if (serviceReference.name !== serviceName || !serviceReference.entrypoint) {
		return;
	}

	entrypoints.add(serviceReference.entrypoint);
}

/**
 * Ensures config-referenced entrypoints can be emitted as JavaScript exports in the wrapper.
 */
function assertValidEntrypointName(entrypointName: string): void {
	if (!/^[A-Za-z_$][\w$]*$/u.test(entrypointName)) {
		throw new Error(
			`Config-referenced entrypoint ${JSON.stringify(entrypointName)} cannot be emitted as a wrapper export.`,
		);
	}
}
