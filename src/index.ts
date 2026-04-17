export {
	createDisk,
	createExternalServer,
	createNetwork,
	createWorker,
	defineConfig,
	durableObject,
	workerEntrypoint,
} from "./config/api";
export { workerd } from "./plugins/plugin";
export { embed } from "./config/syntax";
export type { EmbeddedPath } from "./config/syntax";
export type {
	WorkerdConfig,
} from "./config/workerd";
export type {
	WorkerdPluginOptions,
	InferEnv,
} from "./plugins/types";
