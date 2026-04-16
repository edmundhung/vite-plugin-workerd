import assert from "node:assert";

import type { Plugin } from "vite";

import { VIRTUAL_WORKER_ENTRY } from "../runtime/shared";
import type { WorkerTarget } from "./build";

const VIRTUAL_USER_ENTRY = "virtual:workerd/user-entry";

interface DevPluginContext {
	hotTarget?: WorkerTarget;
}

/**
 * Provides the virtual worker entry that Vite evaluates live during dev.
 */
export function createWorkerdDevVirtualModulesPlugin(
	context: DevPluginContext,
): Plugin {
	return {
		name: "vite-plugin-workerd:dev-virtual-modules",
		apply: "serve",
		async resolveId(source) {
			const target = context.hotTarget;
			if (!target || this.environment.name !== target.environmentName) {
				return;
			}

			if (source === VIRTUAL_USER_ENTRY) {
				const resolved = await this.resolve(target.entryPath);
				if (!resolved) {
					throw new Error(
						`Failed to resolve worker entry file ${JSON.stringify(target.entryPath)} for environment ${JSON.stringify(target.environmentName)}.`,
					);
				}

				return resolved.id;
			}

			if (source === VIRTUAL_WORKER_ENTRY) {
				return `\0${source}`;
			}
		},
		load(id) {
			const target = context.hotTarget;
			if (!target || this.environment.name !== target.environmentName) {
				return;
			}

			if (id !== `\0${VIRTUAL_WORKER_ENTRY}`) {
				return;
			}

			assert(target, "Expected a hot worker target to be defined.");

			return [
				`import * as mod from ${JSON.stringify(VIRTUAL_USER_ENTRY)};`,
				`export * from ${JSON.stringify(VIRTUAL_USER_ENTRY)};`,
				"export default mod.default ?? {};",
				"if (import.meta.hot) {",
				"  import.meta.hot.accept(() => {});",
				"}",
			].join("\n");
		},
	};
}
