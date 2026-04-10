import type {
	BindingTarget,
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
	WorkerReference,
	WorkerReferenceOptions,
	WorkerDefinition,
	WorkerEntrypointExport,
	WorkerExport,
	WorkerExports,
	WorkerOptions,
	ResolutionContext,
	RuntimeExportAccessorMap,
} from "./types";
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

export function workerEntrypoint<Props extends WorkerProps = WorkerProps>(): WorkerEntrypointExport<Props> {
	return { kind: "workerEntrypoint" };
}

export function durableObject(options: DurableObjectOptions = {}): DurableObjectExport {
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

export function createWorker<Exports extends WorkerExports = {}>(
	entry: string,
	options?: WorkerOptions<Exports>,
): WorkerDefinition<Exports> {
	const normalizedOptions: WorkerOptions<Exports> = options ?? {};
	const mutableAccessors: RuntimeExportAccessorMap = {};

	const worker: WorkerDefinition<Exports> = {
		kind: "worker-definition",
		entry,
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

	for (const [exportName, exportDefinition] of Object.entries(
		normalizedOptions.exports ?? {},
	)) {
		if (exportDefinition.kind === "workerEntrypoint") {
			mutableAccessors[exportName] = function workerEntrypointAccessor(
				accessorOptions?: WorkerReferenceOptions,
			): WorkerReference {
				return {
					kind: "service-reference",
					service: worker,
					entrypoint: exportName === "default" ? undefined : exportName,
					props: accessorOptions?.props,
				};
			};
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

export function createNetwork(config: NetworkConfig): NetworkDefinition {
	return {
		kind: "network-definition",
		config,
	};
}

export function createExternalServer(
	config: ExternalServerConfig,
): ExternalServerDefinition {
	return {
		kind: "external-server-definition",
		config,
	};
}

export function createDisk(config: DiskConfig): DiskDefinition {
	return {
		kind: "disk-definition",
		config,
	};
}

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

function isSocketDefinition(socket: SocketInput): socket is SocketDefinition {
	return "kind" in socket && socket.kind === "socket-definition";
}

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

function resolveCacheApiOutbound(
	target: Exclude<BindingTarget, DurableObjectReference>,
	context: ResolutionContext,
): ServiceDesignator {
	return normalizeServiceDesignator(resolveServiceReference(target, context));
}

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

function resolveServiceDesignator(
	designator: string | ServiceDesignator,
): string | ServiceDesignator {
	if (typeof designator === "string") {
		return designator;
	}

	return { ...designator };
}

function normalizeServiceDesignator(
	designator: string | ServiceDesignator,
): ServiceDesignator {
	if (typeof designator === "string") {
		return { name: designator };
	}

	return designator;
}

function nextServiceName(
	kind: keyof ResolutionContext["counters"],
	context: ResolutionContext,
): string {
	const index = ++context.counters[kind];
	return `${kind}:${index}`;
}

function isDurableObjectExport(value: WorkerExport): value is DurableObjectExport {
	return value.kind === "durableObject";
}
