import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
	BindingTarget,
	CreateWorkerOptions,
	DefineConfigInput,
	DiskDefinition,
	DurableObjectExport,
	DurableObjectOptions,
	DurableObjectReference,
	DurableObjectStorage,
	ExportAccessors,
	ExternalServerDefinition,
	WorkerProps,
	ListenOptions,
	NetworkDefinition,
	SocketDefinition,
	SocketInput,
	WorkerBindings,
	WorkerReference,
	WorkerReferenceOptions,
	WorkerDefinition,
	WorkerEntryInput,
	WorkerEntrypointExport,
	WorkerExport,
	WorkerExports,
	WorkerOptions,
	ResolutionContext,
	RuntimeExportAccessorMap,
} from "../plugins/types";
import type {
	DurableObjectNamespaceConfig,
	DurableObjectStorageConfig,
	DiskConfig,
	ExternalServerConfig,
	NetworkConfig,
	ServiceDesignator,
	WorkerBinding,
	WorkerConfig,
	WorkerdConfig,
	WorkerdService,
	WorkerdSocket,
} from "./workerd";
import { embed } from "./syntax";

/**
 * Marks a worker export as an entrypoint accessor.
 */
type NormalizedWorkerEntrypointExport<EntrypointOrProps, Props extends WorkerProps> =
	[EntrypointOrProps] extends [undefined]
		? WorkerEntrypointExport<undefined, Props>
		: EntrypointOrProps extends WorkerProps
			? WorkerEntrypointExport<undefined, EntrypointOrProps>
			: WorkerEntrypointExport<EntrypointOrProps, Props>;

export function workerEntrypoint<
	EntrypointOrProps = undefined,
	Props extends WorkerProps = WorkerProps,
>(): NormalizedWorkerEntrypointExport<EntrypointOrProps, Props> {
	return { kind: "workerEntrypoint" } as NormalizedWorkerEntrypointExport<
		EntrypointOrProps,
		Props
	>;
}

/**
 * Marks a worker export as a Durable Object and validates mutually exclusive options.
 */
export function durableObject<DurableObject = undefined>(
	options: DurableObjectOptions = {},
): DurableObjectExport<DurableObject> {
	if (options.ephemeralLocal && options.uniqueKey) {
		throw new Error(
			"Durable Object exports cannot set both `ephemeralLocal` and `uniqueKey`.",
		);
	}

	return {
		kind: "durableObject",
		...options,
	};
}

/**
 * Creates a worker definition with export accessors and socket helpers.
 * Helper-defined worker entries must be absolute paths or file URLs.
 */
export function createWorker<
	Exports extends WorkerExports = {},
	Bindings extends WorkerBindings = {},
>(
	options: CreateWorkerOptions<Exports, Bindings>,
): WorkerDefinition<Exports, Bindings> {
	const { entry, ...workerOptions } = options;
	const normalizedOptions: WorkerOptions<Exports, Bindings> = workerOptions;
	const mutableAccessors: RuntimeExportAccessorMap = {};
	const entryPath = resolveWorkerEntry(entry);

	const worker: WorkerDefinition<Exports, Bindings> = {
		kind: "worker-definition",
		entry: entryPath,
		options: normalizedOptions,
		exports: mutableAccessors as ExportAccessors<Exports>,
		listen(socketOptions: ListenOptions): SocketDefinition {
			return {
				kind: "socket-definition",
				worker,
				options: socketOptions,
			};
		},
	};
	const createWorkerEntrypointAccessor = (
		entrypoint: string | undefined,
	): ((accessorOptions?: WorkerReferenceOptions) => WorkerReference) => {
		return function workerEntrypointAccessor(
			accessorOptions?: WorkerReferenceOptions,
		): WorkerReference {
			return {
				kind: "service-reference",
				service: worker,
				entrypoint,
				props: accessorOptions?.props,
			};
		};
	};

	if (!("default" in (normalizedOptions.exports ?? {}))) {
		mutableAccessors.default = createWorkerEntrypointAccessor(undefined);
	}

	for (const [exportName, exportDefinition] of Object.entries(
		normalizedOptions.exports ?? {},
	)) {
		if (exportDefinition.kind === "workerEntrypoint") {
			mutableAccessors[exportName] = createWorkerEntrypointAccessor(
				exportName === "default" ? undefined : exportName,
			);
			continue;
		}

		mutableAccessors[exportName] = function durableObjectAccessor(): DurableObjectReference {
			return {
				kind: "durable-object-reference",
				worker,
				exportName,
			};
		};
	}

	return worker;
}

/**
 * Normalizes helper-defined worker entries to absolute filesystem paths.
 */
function resolveWorkerEntry(entry: WorkerEntryInput): string {
	if (entry instanceof URL) {
		if (entry.protocol !== "file:") {
			throw new Error(
				`createWorker() only accepts file URLs. Received ${JSON.stringify(entry.href)}.`,
			);
		}

		return fileURLToPath(entry);
	}

	if (path.isAbsolute(entry)) {
		return entry;
	}

	throw new Error(
		`createWorker() entry must be an absolute path or file URL. Use new URL(${JSON.stringify(entry)}, import.meta.url) instead of a relative string.`,
	);
}

/**
 * Wraps a network config so it can be lowered into a named service.
 */
export function createNetwork(config: NetworkConfig): NetworkDefinition {
	return {
		kind: "network-definition",
		config,
	};
}

/**
 * Wraps an external server config so it can be lowered into a named service.
 */
export function createExternalServer(
	config: ExternalServerConfig,
): ExternalServerDefinition {
	return {
		kind: "external-server-definition",
		config,
	};
}

/**
 * Wraps a disk config so it can be lowered into a named service.
 */
export function createDisk(config: DiskConfig): DiskDefinition {
	return {
		kind: "disk-definition",
		config,
	};
}

/**
 * Lowers helper-authored sockets and services into a raw workerd config.
 */
export function defineConfig(input: DefineConfigInput = {}): WorkerdConfig {
	const context: ResolutionContext = {
		services: [],
		workerNames: new Map(),
		networkNames: new Map(),
		externalNames: new Map(),
		diskNames: new Map(),
		counters: {
			worker: 0,
			network: 0,
			external: 0,
			disk: 0,
		},
	};

	const sockets = (input.sockets ?? []).map((socket) =>
		resolveSocket(socket, context),
	);

	return {
		services: context.services,
		sockets,
		v8Flags: input.v8Flags,
		extensions: input.extensions,
		autogates: input.autogates,
		structuredLogging: input.structuredLogging,
	};
}

/**
 * Resolves a socket helper or raw socket into a workerd socket.
 */
function resolveSocket(socket: SocketInput, context: ResolutionContext): WorkerdSocket {
	if (!isSocketDefinition(socket)) {
		return {
			...socket,
			service: resolveServiceDesignator(socket.service),
		};
	}

	const serviceName = ensureWorkerService(socket.worker, context);
	const lowered: WorkerdSocket = {
		name: socket.options.name,
		address: socket.options.address,
		service: serviceName,
	};

	if (socket.options.protocol === "http") {
		lowered.http = socket.options.http ?? {};
	} else {
		lowered.https = socket.options.https ?? {};
	}

	return lowered;
}

/**
 * Checks whether a socket input came from `worker.listen()`.
 */
function isSocketDefinition(socket: SocketInput): socket is SocketDefinition {
	return "kind" in socket && socket.kind === "socket-definition";
}

/**
 * Interns a worker definition as a named service and returns its service name.
 */
function ensureWorkerService(
	worker: WorkerDefinition,
	context: ResolutionContext,
): string {
	const existing = context.workerNames.get(worker);
	if (existing) {
		return existing;
	}

	const serviceName = nextServiceName("worker", context);
	context.workerNames.set(worker, serviceName);

	const insertionIndex = context.services.length;
	const resolvedWorker = resolveWorker(worker, serviceName, context);
	const service = {
		name: serviceName,
		worker: resolvedWorker,
	};
	context.services.splice(insertionIndex, 0, service);

	return serviceName;
}

/**
 * Interns a network definition as a named service.
 */
function ensureNetworkService(
	network: NetworkDefinition,
	context: ResolutionContext,
): string {
	const existing = context.networkNames.get(network);
	if (existing) {
		return existing;
	}

	const serviceName = nextServiceName("network", context);
	context.networkNames.set(network, serviceName);
	context.services.push({
		name: serviceName,
		network: { ...network.config },
	});
	return serviceName;
}

/**
 * Interns an external server definition as a named service.
 */
function ensureExternalService(
	external: ExternalServerDefinition,
	context: ResolutionContext,
): string {
	const existing = context.externalNames.get(external);
	if (existing) {
		return existing;
	}

	const serviceName = nextServiceName("external", context);
	context.externalNames.set(external, serviceName);
	context.services.push({
		name: serviceName,
		external: { ...external.config },
	});
	return serviceName;
}

/**
 * Interns a disk definition as a named service.
 */
function ensureDiskService(disk: DiskDefinition, context: ResolutionContext): string {
	const existing = context.diskNames.get(disk);
	if (existing) {
		return existing;
	}

	const serviceName = nextServiceName("disk", context);
	context.diskNames.set(disk, serviceName);
	context.services.push({
		name: serviceName,
		disk: { ...disk.config },
	});
	return serviceName;
}

/**
 * Lowers a high-level worker definition into a raw workerd worker config.
 */
function resolveWorker(
	worker: WorkerDefinition,
	serviceName: string,
	context: ResolutionContext,
): WorkerConfig {
	const exports = worker.options.exports ?? {};
	const namespaces = resolveDurableObjectNamespaces(exports, serviceName);
	const storage = resolveDurableObjectStorage(worker.options.durableObjectStorage, namespaces, context);

	return {
		modules: [
			{
				name: "main",
				esModule: embed(worker.entry),
			},
		],
		compatibilityDate: worker.options.compatibilityDate,
		compatibilityFlags: worker.options.compatibilityFlags,
		bindings: Object.entries(worker.options.bindings ?? {}).map(([name, target]) =>
			resolveBinding(name, target, serviceName, context),
		),
		durableObjectNamespaces: namespaces,
		durableObjectStorage: storage,
		globalOutbound: worker.options.globalOutbound
			? resolveServiceReference(worker.options.globalOutbound, context)
			: undefined,
		cacheApiOutbound: worker.options.cacheApiOutbound
			? resolveCacheApiOutbound(worker.options.cacheApiOutbound, context)
			: undefined,
		tails: worker.options.tails?.map((tailWorker) =>
			ensureWorkerService(tailWorker, context),
		),
		streamingTails: worker.options.streamingTails?.map((tailWorker) =>
			ensureWorkerService(tailWorker, context),
		),
	};
}

/**
 * Lowers one helper binding into a workerd binding record.
 */
function resolveBinding(
	name: string,
	target: BindingTarget,
	currentServiceName: string,
	context: ResolutionContext,
): WorkerBinding {
	if (target.kind === "durable-object-reference") {
		const targetServiceName = ensureWorkerService(target.worker, context);
		const targetExport = target.worker.options.exports?.[target.exportName];
		if (!targetExport || targetExport.kind !== "durableObject") {
			throw new Error(
				`Durable Object export \`${target.exportName}\` was not found on its worker definition.`,
			);
		}

		const className = targetExport.className ?? target.exportName;
		return {
			name,
			durableObjectNamespace:
				targetServiceName === currentServiceName
					? className
					: {
						className,
						serviceName: targetServiceName,
					},
		};
	}

	return {
		name,
		service: resolveServiceReference(target, context),
	};
}

/**
 * Collects Durable Object namespace declarations from worker exports.
 */
function resolveDurableObjectNamespaces(
	exports: WorkerExports,
	serviceName: string,
): DurableObjectNamespaceConfig[] | undefined {
	const namespaces: DurableObjectNamespaceConfig[] = [];

	for (const [exportName, value] of Object.entries(exports)) {
		if (!isDurableObjectExport(value)) {
			continue;
		}

		namespaces.push({
			className: value.className ?? exportName,
			uniqueKey: value.ephemeralLocal
				? undefined
				: (value.uniqueKey ?? `do:${serviceName}:${exportName}`),
			ephemeralLocal: value.ephemeralLocal,
			preventEviction: value.preventEviction,
		});
	}

	return namespaces.length > 0 ? namespaces : undefined;
}

/**
 * Validates and lowers Durable Object storage for workers that export Durable Objects.
 */
function resolveDurableObjectStorage(
	storage: DurableObjectStorage | undefined,
	namespaces: DurableObjectNamespaceConfig[] | undefined,
	context: ResolutionContext,
): DurableObjectStorageConfig | undefined {
	if (!namespaces || namespaces.length === 0) {
		return undefined;
	}

	if (!storage) {
		throw new Error(
			"Workers with Durable Object exports must declare durableObjectStorage.",
		);
	}

	if ("inMemory" in storage) {
		return { inMemory: true };
	}

	return {
		localDisk: ensureDiskService(storage.disk, context),
	};
}

/**
 * Normalizes `cacheApiOutbound` to a service designator.
 */
function resolveCacheApiOutbound(
	target: Exclude<BindingTarget, DurableObjectReference>,
	context: ResolutionContext,
): ServiceDesignator {
	return normalizeServiceDesignator(resolveServiceReference(target, context));
}

/**
 * Converts a helper-level service target into a raw service reference or service name.
 */
function resolveServiceReference(
	target:
		| NetworkDefinition
		| ExternalServerDefinition
		| WorkerDefinition
		| WorkerReference,
	context: ResolutionContext,
): string | ServiceDesignator {
	if (target.kind === "service-reference") {
		return {
			name: ensureWorkerService(target.service, context),
			entrypoint: target.entrypoint,
			props:
				target.props === undefined
					? undefined
					: { json: JSON.stringify(target.props) },
		};
	}

	if (target.kind === "worker-definition") {
		return ensureWorkerService(target, context);
	}

	if (target.kind === "network-definition") {
		return ensureNetworkService(target, context);
	}

	return ensureExternalService(target, context);
}

/**
 * Clones an explicit service designator and passes through string service names.
 */
function resolveServiceDesignator(
	designator: string | ServiceDesignator,
): string | ServiceDesignator {
	if (typeof designator === "string") {
		return designator;
	}

	return { ...designator };
}

/**
 * Converts a string service designator into object form.
 */
function normalizeServiceDesignator(
	designator: string | ServiceDesignator,
): ServiceDesignator {
	if (typeof designator === "string") {
		return { name: designator };
	}

	return designator;
}

/**
 * Allocates the next generated service name for a helper-defined resource.
 */
function nextServiceName(
	kind: keyof ResolutionContext["counters"],
	context: ResolutionContext,
): string {
	const index = ++context.counters[kind];
	return `${kind}${index}`;
}

/**
 * Checks whether a worker export is a Durable Object declaration.
 */
function isDurableObjectExport(value: WorkerExport): value is DurableObjectExport {
	return value.kind === "durableObject";
}
