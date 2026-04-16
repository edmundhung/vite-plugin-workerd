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

export interface WorkerEntrypointExport<Props extends WorkerProps = WorkerProps> {
	kind: "workerEntrypoint";
	_props?: Props;
}

export interface DurableObjectExport {
	kind: "durableObject";
	className?: string;
	uniqueKey?: string;
	ephemeralLocal?: true;
	preventEviction?: boolean;
}

export interface DurableObjectOptions {
	className?: string;
	uniqueKey?: string;
	ephemeralLocal?: true;
	preventEviction?: boolean;
}

export type WorkerExport = WorkerEntrypointExport | DurableObjectExport;
export interface WorkerExports {
	[key: string]: WorkerExport;
}
export interface WorkerReference {
	readonly kind: "service-reference";
	readonly service: WorkerDefinition;
	readonly entrypoint?: string;
	readonly props?: WorkerProps;
}

export interface DurableObjectReference {
	readonly kind: "durable-object-reference";
	readonly worker: WorkerDefinition;
	readonly exportName: string;
}

export interface WorkerReferenceOptions {
	props?: WorkerProps;
}

type IsExactlyWorkerProps<Props> = [Props] extends [WorkerProps]
	? [WorkerProps] extends [Props]
		? true
		: false
	: false;

export type DurableObjectStorage = { inMemory: true } | { disk: DiskDefinition };

export type BindingTarget =
	| WorkerDefinition
	| NetworkDefinition
	| ExternalServerDefinition
	| WorkerReference
	| DurableObjectReference;

export type WorkerEntryInput = string | URL;

export type WorkerOptions<Exports extends WorkerExports = any> = {
	compatibilityDate?: string;
	compatibilityFlags?: string[];
	bindings?: Record<string, BindingTarget>;
	exports?: Exports;
	durableObjectStorage?: DurableObjectStorage;
	globalOutbound?: NetworkDefinition | ExternalServerDefinition;
	cacheApiOutbound?: Exclude<BindingTarget, DurableObjectReference>;
	tails?: WorkerDefinition[];
	streamingTails?: WorkerDefinition[];
};

export type CreateWorkerOptions<Exports extends WorkerExports = any> = WorkerOptions<Exports> & {
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

export type WorkerEntrypointAccessor<Props extends WorkerProps = WorkerProps> =
	[Props] extends [never]
		? () => WorkerReference
		: IsExactlyWorkerProps<Props> extends true
			? (options?: WorkerReferenceOptions) => WorkerReference
			: (options: { props: Props }) => WorkerReference;

type ExportAccessor<Export extends WorkerExport> =
	Export extends WorkerEntrypointExport<infer Props>
		? WorkerEntrypointAccessor<Props>
		: Export extends DurableObjectExport
			? () => DurableObjectReference
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

export interface WorkerDefinition<Exports extends WorkerExports = any> {
	readonly kind: "worker-definition";
	readonly entry: string;
	readonly options: WorkerOptions<Exports>;
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
	readonly worker: WorkerDefinition;
	readonly options: ListenOptions;
}

export type SocketInput = SocketDefinition | WorkerdSocket;

export interface ResolutionContext {
	services: WorkerdService[];
	workerNames: Map<WorkerDefinition, string>;
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
