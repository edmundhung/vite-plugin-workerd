import type {
	CapnpValue,
	DiskConfig,
	ExternalServerConfig,
	NetworkConfig,
	WorkerdConfig,
	WorkerdService,
	WorkerdSocket,
} from "../config/workerd";

export type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	| { [key: string]: Json };

export interface WorkerProps {
	[key: string]: Json;
}

type WorkersTypesModule = typeof import("@cloudflare/workers-types");

export interface WorkerEntrypointExport<Entrypoint = undefined, Props extends WorkerProps = WorkerProps> {
	kind: "workerEntrypoint";
	_entrypoint?: Entrypoint;
	_props?: Props;
}

export interface DurableObjectExport<DurableObject = undefined> {
	kind: "durableObject";
	className?: string;
	uniqueKey?: string;
	ephemeralLocal?: true;
	preventEviction?: boolean;
	_durableObject?: DurableObject;
}

export interface DurableObjectOptions {
	className?: string;
	uniqueKey?: string;
	ephemeralLocal?: true;
	preventEviction?: boolean;
}

export type WorkerExport = WorkerEntrypointExport<any, any> | DurableObjectExport<any>;
export interface WorkerExports {
	[key: string]: WorkerExport;
}
export interface WorkerReference<Entrypoint = undefined, Props extends WorkerProps = WorkerProps> {
	readonly kind: "service-reference";
	readonly service: WorkerDefinition<any, any>;
	readonly entrypoint?: string;
	readonly props?: Props;
	readonly __entrypoint?: Entrypoint;
}

export interface DurableObjectReference<DurableObject = undefined> {
	readonly kind: "durable-object-reference";
	readonly worker: WorkerDefinition<any, any>;
	readonly exportName: string;
	readonly __durableObject?: DurableObject;
}

export interface WorkerReferenceOptions<Props extends WorkerProps = WorkerProps> {
	props?: Props;
}

type IsExactlyWorkerProps<Props> = [Props] extends [WorkerProps]
	? [WorkerProps] extends [Props]
		? true
		: false
	: false;

export type DurableObjectStorage = { inMemory: true } | { disk: DiskDefinition };

export type WorkerBindings = Record<string, BindingTarget>;

export type BindingTarget =
	| WorkerDefinition<any, any>
	| NetworkDefinition
	| ExternalServerDefinition
	| WorkerReference<any, any>
	| DurableObjectReference<any>;

export type WorkerEntryInput = string | URL;

export type WorkerOptions<
	Exports extends WorkerExports = any,
	Bindings extends WorkerBindings = WorkerBindings,
> = {
	compatibilityDate?: string;
	compatibilityFlags?: string[];
	bindings?: Bindings;
	exports?: Exports;
	durableObjectStorage?: DurableObjectStorage;
	globalOutbound?: NetworkDefinition | ExternalServerDefinition;
	cacheApiOutbound?: Exclude<BindingTarget, DurableObjectReference>;
	tails?: WorkerDefinition<any, any>[];
	streamingTails?: WorkerDefinition<any, any>[];
};

export type CreateWorkerOptions<
	Exports extends WorkerExports = any,
	Bindings extends WorkerBindings = WorkerBindings,
> = WorkerOptions<Exports, Bindings> & {
	entry: WorkerEntryInput;
};

export interface ListenOptions {
	name: string;
	address?: string;
	protocol: "http" | "https";
	http?: CapnpValue;
	https?: {
		options?: CapnpValue;
		tlsOptions?: CapnpValue;
	};
}

export type WorkerEntrypointAccessor<
	Entrypoint = undefined,
	Props extends WorkerProps = WorkerProps,
> =
	[Props] extends [never]
		? () => WorkerReference<Entrypoint, Props>
		: IsExactlyWorkerProps<Props> extends true
			? (options?: WorkerReferenceOptions<Props>) => WorkerReference<Entrypoint, Props>
			: (options: { props: Props }) => WorkerReference<Entrypoint, Props>;

type ExportAccessor<Export extends WorkerExport> =
	Export extends WorkerEntrypointExport<infer Entrypoint, infer Props>
		? WorkerEntrypointAccessor<Entrypoint, Props>
		: Export extends DurableObjectExport<infer DurableObject>
			? () => DurableObjectReference<DurableObject>
			: never;

type ImplicitDefaultExportAccessor<Exports extends WorkerExports> =
	"default" extends keyof Exports
		? {}
		: { default: WorkerEntrypointAccessor };

export type ExportAccessors<Exports extends WorkerExports> = {
	[K in keyof Exports]: ExportAccessor<Exports[K]>;
} & ImplicitDefaultExportAccessor<Exports>;

export type RuntimeExportAccessor =
	| ((options?: WorkerReferenceOptions) => WorkerReference)
	| (() => DurableObjectReference);

export interface RuntimeExportAccessorMap {
	[key: string]: RuntimeExportAccessor;
}

export interface WorkerDefinition<
	Exports extends WorkerExports = any,
	Bindings extends WorkerBindings = WorkerBindings,
> {
	readonly kind: "worker-definition";
	readonly entry: string;
	readonly options: WorkerOptions<Exports, Bindings>;
	readonly exports: ExportAccessors<Exports>;
	listen(options: ListenOptions): SocketDefinition;
}

export interface NetworkDefinition {
	readonly kind: "network-definition";
	readonly config: NetworkConfig;
}

export interface ExternalServerDefinition {
	readonly kind: "external-server-definition";
	readonly config: ExternalServerConfig;
}

export interface DiskDefinition {
	readonly kind: "disk-definition";
	readonly config: DiskConfig;
}

export interface SocketDefinition {
	readonly kind: "socket-definition";
	readonly worker: WorkerDefinition<any, any>;
	readonly options: ListenOptions;
}

export type SocketInput = SocketDefinition | WorkerdSocket;

export interface ResolutionContext {
	services: WorkerdService[];
	workerNames: Map<WorkerDefinition<any, any>, string>;
	networkNames: Map<NetworkDefinition, string>;
	externalNames: Map<ExternalServerDefinition, string>;
	diskNames: Map<DiskDefinition, string>;
	counters: {
		worker: number;
		network: number;
		external: number;
		disk: number;
	};
}

export interface DefineConfigInput {
	sockets?: SocketInput[];
	v8Flags?: string[];
	extensions?: WorkerdConfig["extensions"];
	autogates?: string[];
	structuredLogging?: boolean;
}

type NormalizeServiceTarget<T> =
	WorkersTypesModule extends unknown
		? T extends new (...args: any[]) => Rpc.WorkerEntrypointBranded
			? T
			: T extends Rpc.WorkerEntrypointBranded | ExportedHandler<any, any, any, any> | undefined
				? T
				: undefined
		: never;

type NormalizeDurableObjectTarget<T> =
	WorkersTypesModule extends unknown
		? T extends new (...args: any[]) => infer Instance
			? Instance extends Rpc.DurableObjectBranded
				? Instance
				: undefined
			: T extends Rpc.DurableObjectBranded | undefined
				? T
				: undefined
		: never;

type DefaultEntrypointType<Exports extends WorkerExports> = Exports extends {
	default: WorkerEntrypointExport<infer Entrypoint, any>;
}
	? Entrypoint
	: undefined;

type InferBinding<Target> =
	Target extends WorkerReference<infer Entrypoint, any>
		? Service<NormalizeServiceTarget<Entrypoint>>
		: Target extends WorkerDefinition<infer Exports, any>
			? Service<NormalizeServiceTarget<DefaultEntrypointType<Exports>>>
			: Target extends DurableObjectReference<infer DurableObject>
				? DurableObjectNamespace<NormalizeDurableObjectTarget<DurableObject>>
				: Target extends NetworkDefinition | ExternalServerDefinition
					? Fetcher
					: never;

type InferBindings<Bindings extends WorkerBindings> = {
	[K in keyof Bindings]: InferBinding<Bindings[K]>;
};

export type InferEnv<T> = T extends WorkerDefinition<any, infer Bindings>
	? InferBindings<Bindings>
	: T extends WorkerBindings
		? InferBindings<T>
		: never;

export interface WorkerdPluginFileOptions {
	defaultSocket?: string;
	configFile?: string;
	config?: never;
}

export interface WorkerdPluginInlineOptions {
	defaultSocket?: string;
	config:
		| WorkerdConfig
		| (() => WorkerdConfig | Promise<WorkerdConfig>);
	configFile?: never;
}

export type WorkerdPluginOptions = WorkerdPluginFileOptions | WorkerdPluginInlineOptions;
