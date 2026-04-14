import type { EmbeddedPath } from "./syntax";

export type CapnpValue =
	| null
	| boolean
	| number
	| string
	| CapnpValue[]
	| { [key: string]: CapnpValue | undefined };

export interface ServiceDesignator {
	name: string;
	entrypoint?: string;
	props?: { json: string };
}

export type ServiceReferenceConfig = string | ServiceDesignator;

export interface WorkerEsModule {
	name: string;
	esModule: EmbeddedPath;
}

export interface DurableObjectNamespaceDesignator {
	className: string;
	serviceName?: string;
}

export interface DurableObjectNamespaceConfig {
	className: string;
	uniqueKey?: string;
	ephemeralLocal?: true;
	preventEviction?: boolean;
}

export type WorkerBinding =
	| {
			name: string;
			service: ServiceReferenceConfig;
	  }
	| {
			name: string;
			durableObjectNamespace: string | DurableObjectNamespaceDesignator;
	  };

export type DurableObjectStorageConfig = { inMemory: true } | { localDisk: string };

export interface WorkerConfig {
	modules?: WorkerEsModule[];
	compatibilityDate?: string;
	compatibilityFlags?: string[];
	bindings?: WorkerBinding[];
	durableObjectNamespaces?: DurableObjectNamespaceConfig[];
	durableObjectStorage?: DurableObjectStorageConfig;
	globalOutbound?: ServiceReferenceConfig;
	cacheApiOutbound?: ServiceReferenceConfig;
	tails?: ServiceReferenceConfig[];
	streamingTails?: ServiceReferenceConfig[];
}

export interface NetworkConfig {
	allow?: string[];
	deny?: string[];
	tlsOptions?: CapnpValue;
}

export interface ExternalServerConfig {
	address?: string;
	http?: CapnpValue;
	https?: {
		options?: CapnpValue;
		tlsOptions?: CapnpValue;
		certificateHost?: string;
	};
	tcp?: {
		tlsOptions?: CapnpValue;
		certificateHost?: string;
	};
}

export interface DiskConfig {
	path: string;
	writable?: boolean;
	allowDotfiles?: boolean;
}

export type WorkerdService =
	| { name: string; worker: WorkerConfig }
	| { name: string; network: NetworkConfig }
	| { name: string; external: ExternalServerConfig }
	| { name: string; disk: DiskConfig };

export interface WorkerdSocket {
	name: string;
	address?: string;
	service: ServiceReferenceConfig;
	http?: CapnpValue;
	https?: {
		options?: CapnpValue;
		tlsOptions?: CapnpValue;
	};
}

export interface WorkerdConfig {
	services: WorkerdService[];
	sockets: WorkerdSocket[];
	v8Flags?: string[];
	extensions?: CapnpValue[];
	autogates?: string[];
	structuredLogging?: boolean;
}
