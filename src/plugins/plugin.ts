import path from "node:path";

import { type Plugin, type PluginOption } from "vite";

import {
	createBuildApp,
	createBuildContext,
	createWorkerEnvironmentOptions,
	rewriteConfigWithBundledWorkerModules,
	type WorkerdBuildContext,
	writeSerializedConfig,
} from "./build";
import { embed } from "../config/syntax";
import { loadWorkerdConfig, resolveConfigRoot } from "../config/load";
import { createWorkerdDevPlugin, type WorkerdDevPluginContext } from "./dev";
import { createWorkerdDevVirtualModulesPlugin } from "./dev-virtual-modules";
import { prepareConfigForSerialization, serializeConfig } from "../config/serialize";
import type { WorkerdPluginOptions } from "./types";

/**
 * Creates the Vite plugins that bundle worker services for build and run workerd in dev.
 */
export function workerd(options: WorkerdPluginOptions = {}): PluginOption {
	const devContext: WorkerdDevPluginContext = {};

	return [
		createWorkerdBuildPlugin(options),
		createWorkerdDevVirtualModulesPlugin(devContext),
		createWorkerdDevPlugin(options, devContext),
	];
}

/**
 * Creates the build-only plugin that emits bundled workers and `workerd.capnp`.
 */
function createWorkerdBuildPlugin(options: WorkerdPluginOptions): Plugin {
	let buildContext!: WorkerdBuildContext;

	return {
		name: "vite-plugin-workerd",
		apply: "build",
		sharedDuringBuild: true,
		async config(userConfig, env) {
			const root = resolveConfigRoot(userConfig);
			const { config } = await loadWorkerdConfig(options, root, env);
			const outDir = userConfig.build?.outDir ?? "dist";
			const existingBuildApp = userConfig.builder?.buildApp;

			buildContext = createBuildContext({
				root,
				outDir,
				config,
			});

			return {
				appType: "custom",
				environments: Object.fromEntries(
					buildContext.workerTargets.map((target) => [
						target.environmentName,
						createWorkerEnvironmentOptions(target, "production"),
					]),
				),
				builder: {
					async buildApp(builder) {
						if (existingBuildApp) {
							await existingBuildApp(builder);
						}

						return createBuildApp(buildContext)(builder);
					},
				},
			};
		},
		generateBundle(_, bundle) {
			const target = buildContext.workerTargets.find(
				(workerTarget) => workerTarget.environmentName === this.environment.name,
			);
			if (!target) {
				return;
			}

			const modules = [];

			for (const output of Object.values(bundle)) {
				if (output.type !== "chunk") {
					continue;
				}

				modules.push({
					name: output.isEntry ? "main" : `./${output.fileName}`,
					esModule: embed(path.join(target.outputDirectory, output.fileName)),
				});
			}

			if (modules.length === 0) {
				throw new Error(
					`Expected worker build to emit at least one JavaScript chunk for service \`${target.serviceName}\`.`,
				);
			}

			buildContext.bundledWorkerModulesByService.set(target.serviceName, modules);
		},
		buildApp: {
			order: "post",
			async handler() {
				const bundledConfig = rewriteConfigWithBundledWorkerModules(
					buildContext.config,
					buildContext.bundledWorkerModulesByService,
				);
				const model = prepareConfigForSerialization(bundledConfig, {
					outputPath: buildContext.outputPath,
				});
				const source = serializeConfig(model);

				writeSerializedConfig({
					outputPath: buildContext.outputPath,
					source,
				});
			},
		},
	};
}
