import fs from "node:fs";
import path from "node:path";

import type { EnvironmentOptions, ViteBuilder } from "vite";

import { embed, getEmbeddedPath, isEmbeddedPath } from "./syntax";
import type { WorkerEsModule, WorkerdConfig, WorkerdService } from "./workerd";

const WORKER_ENVIRONMENT_PREFIX = "workerd_";
const WORKER_RESOLVE_CONDITIONS = ["workerd", "worker", "module", "browser"];
const WORKER_BUILD_CONDITION = "production";
const WORKER_OUTPUT_DIRECTORY = "workers";
const WORKERD_CONFIG_NAME = "workerd.capnp";

export interface WorkerTarget {
	environmentName: string;
	serviceName: string;
	entryPath: string;
	outputDirectory: string;
	outputFileName: string;
	chunkFileNamePattern: string;
	assetFileNamePattern: string;
}

export interface WorkerdBuildContext {
	config: WorkerdConfig;
	outputPath: string;
	workerTargets: WorkerTarget[];
	bundledWorkerModulesByService: Map<string, WorkerEsModule[]>;
}

/**
 * Creates the shared build context used across Vite's config and build hooks.
 */
export function createBuildContext(options: {
	root: string;
	outDir: string;
	config: WorkerdConfig;
}): WorkerdBuildContext {
	const outDir = path.resolve(options.root, options.outDir);
	const workerOutputDirectory = path.join(outDir, WORKER_OUTPUT_DIRECTORY);
	const usedNames = new Set<string>();

	const workerTargets = options.config.services.flatMap((service) => {
		if (!isWorkerService(service)) {
			return [];
		}

		const mainModule = getMainModule(service.name, service.worker.modules);
		const baseName = service.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "worker";
		if (usedNames.has(baseName)) {
			throw new Error(
				`workerd worker service \`${service.name}\` normalizes to the same build name as another service: \`${baseName}\`.`,
			);
		}
		usedNames.add(baseName);

		return [
			{
				environmentName: `${WORKER_ENVIRONMENT_PREFIX}${baseName}`,
				serviceName: service.name,
				entryPath: getEmbeddedPath(mainModule.esModule),
				outputDirectory: workerOutputDirectory,
				outputFileName: `${baseName}.js`,
				chunkFileNamePattern: `${baseName}-[name]-[hash].js`,
				assetFileNamePattern: `${baseName}-[name]-[hash][extname]`,
			},
		];
	});

	return {
		config: options.config,
		outputPath: path.join(outDir, WORKERD_CONFIG_NAME),
		workerTargets,
		bundledWorkerModulesByService: new Map(),
	};
}

/**
 * Returns the Vite environment options used to bundle a single worker service.
 */
export function createWorkerEnvironmentOptions(
	target: WorkerTarget,
): EnvironmentOptions {
	return {
		resolve: {
			noExternal: true,
			conditions: [...WORKER_RESOLVE_CONDITIONS, WORKER_BUILD_CONDITION],
		},
		build: {
			ssr: true,
			target: "esnext",
			emptyOutDir: false,
			copyPublicDir: false,
			outDir: target.outputDirectory,
			rollupOptions: {
				input: target.entryPath,
				preserveEntrySignatures: "strict",
				output: {
					format: "es",
					entryFileNames: target.outputFileName,
					chunkFileNames: target.chunkFileNamePattern,
					assetFileNames: target.assetFileNamePattern,
				},
			},
		},
	};
}

/**
 * Builds every configured worker environment and records the emitted worker modules.
 */
export function createBuildApp(context: WorkerdBuildContext): (builder: ViteBuilder) => Promise<void> {
	return async (builder) => {
		await Promise.all(
			context.workerTargets.map(async (target) => {
				const environment = builder.environments[target.environmentName];
				if (!environment) {
					throw new Error(`Expected Vite environment \`${target.environmentName}\` to be defined.`);
				}

				if (environment.isBuilt) {
					return;
				}

				await builder.build(environment);
			}),
		);
	};
}

/**
 * Replaces source-backed worker modules with the modules emitted by the worker build.
 */
export function rewriteConfigForBundledWorkers(context: WorkerdBuildContext): WorkerdConfig {
	return {
		...context.config,
		services: context.config.services.map((service) => {
			if (!isWorkerService(service)) {
				return service;
			}

			const bundledModules = context.bundledWorkerModulesByService.get(service.name);
			if (!bundledModules) {
				throw new Error(`Expected bundled worker modules for service \`${service.name}\`.`);
			}

			return {
				...service,
				worker: {
					...service.worker,
					modules: bundledModules,
				},
			};
		}),
	};
}

/**
 * Writes the serialized workerd config to disk.
 */
export function writeSerializedConfig(options: {
	outputPath: string;
	source: string;
}): void {
	fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
	fs.writeFileSync(options.outputPath, options.source);
}

/**
 * Returns the single source-backed `main` module required for worker builds.
 */
function getMainModule(
	serviceName: string,
	modules: WorkerEsModule[] | undefined,
): WorkerEsModule {
	if (!modules || modules.length === 0) {
		throw new Error(
			`workerd worker service \`${serviceName}\` must define a source-backed \`main\` module for vite build.`,
		);
	}

	const mainModules = modules.filter((module) => module.name === "main");
	if (mainModules.length !== 1) {
		throw new Error(
			`workerd worker service \`${serviceName}\` must define exactly one source-backed \`main\` module for vite build.`,
		);
	}

	const mainModule = mainModules[0];
	if (!isEmbeddedPath(mainModule.esModule)) {
		throw new Error(
			`workerd worker service \`${serviceName}\` must use embed(...) for its \`main\` module.`,
		);
	}

	return mainModule;
}

/**
 * Checks whether a service record is a worker service.
 */
function isWorkerService(service: WorkerdService): service is Extract<WorkerdService, { worker: unknown }> {
	return "worker" in service;
}
