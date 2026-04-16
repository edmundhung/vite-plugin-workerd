import { normalizePath, type EnvironmentOptions } from "vite";

const WORKER_BASE_RESOLVE_CONDITIONS = ["workerd", "worker", "module", "browser"] as const;
const WORKER_OPTIMIZE_DEPS_EXCLUDE = ["cloudflare:workers"] as const;

export const WORKER_ENVIRONMENT_PREFIX = "workerd_";
export const WORKER_EXTERNAL_IDS = [/^cloudflare:/u, /^node:/u];

/**
 * Creates shared resolve options for worker-targeted Vite environments.
 */
export function createWorkerResolveOptions(
	mode?: "development" | "production",
): NonNullable<EnvironmentOptions["resolve"]> {
	return {
		noExternal: true,
		conditions: [...WORKER_BASE_RESOLVE_CONDITIONS, ...(mode ? [mode] : [])],
		builtins: [...WORKER_EXTERNAL_IDS],
	};
}

/**
 * Creates shared optimizeDeps options for worker-targeted Vite environments.
 */
export function createWorkerOptimizeDepsOptions(
	entryPath: string,
): NonNullable<EnvironmentOptions["optimizeDeps"]> {
	return {
		noDiscovery: false,
		entries: normalizePath(entryPath),
		exclude: [...WORKER_OPTIMIZE_DEPS_EXCLUDE],
	};
}
