export const CONTROL_SOCKET_NAME = "__vite_plugin_workerd_control__";
export const CONTROL_SERVICE_BINDING = "__VITE_CONTROL_SERVICE__";
export const CONTROL_SERVICE_NAME = "__vite_plugin_workerd_control_service__";
export const INIT_PATH = "/__vite_plugin_workerd_init__";
export const WORKER_CODE_PATH = "/__vite_plugin_workerd_worker_code__";
export const RUNNER_OBJECT_BINDING = "__VITE_RUNNER_OBJECT__";
export const RUNNER_OBJECT_CLASS_NAME = "__VITE_RUNNER_OBJECT__";
export const RUNNER_OBJECT_ID = "singleton";
export const WORKER_LOADER_BINDING = "__VITE_WORKER_LOADER__";
export const INVALIDATE_WORKER_CODE_EVENT = "vite-plugin-workerd:invalidate-worker-code";
export const RESOLVE_WORKER_CODE_EVENT = "vite-plugin-workerd:resolve-worker-code";
export const RESOLVE_WORKER_CODE_RESULT_EVENT = "vite-plugin-workerd:resolve-worker-code:result";

export interface WorkerLoaderModulePayload {
	js?: string;
	cjs?: string;
}

export interface WorkerLoaderCodePayload {
	generation: string;
	compatibilityDate: string;
	compatibilityFlags?: string[];
	allowExperimental?: boolean;
	mainModule: string;
	modules: Record<string, WorkerLoaderModulePayload>;
}

export interface ResolveWorkerCodeRequest {
	requestId: string;
	serviceName: string;
}

export interface ResolveWorkerCodeResult {
	requestId: string;
	serviceName?: string;
	code?: WorkerLoaderCodePayload;
	error?: string;
}
