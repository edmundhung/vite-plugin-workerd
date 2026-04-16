import fs from "node:fs";
import path from "node:path";

import { loadConfigFromFile, type ConfigEnv } from "vite";

import { embed, getEmbeddedPath, isEmbeddedPath } from "./syntax";
import type { WorkerdPluginOptions } from "../plugins/types";
import type { WorkerdConfig } from "./workerd";

const DEFAULT_CONFIG_BASENAME = "workerd.config";
const DEFAULT_WORKERD_CONFIG_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;

export interface LoadedWorkerdConfig {
	config: WorkerdConfig;
	path?: string;
	dependencies: string[];
}

/**
 * Loads the workerd config from inline options or the default config file on disk.
 */
export async function loadWorkerdConfig(
	options: WorkerdPluginOptions,
	root: string,
	env: ConfigEnv,
): Promise<LoadedWorkerdConfig> {
	if (options.config !== undefined) {
		const resolvedConfig =
			typeof options.config === "function"
				? await options.config()
				: options.config;

		return {
			config: parseWorkerdConfig(resolvedConfig, root),
			dependencies: [],
		};
	}

	const configFile = options.configFile ?? findDefaultConfigFile(root);

	if (!configFile) {
		throw new Error(
			`Could not find a default workerd config file matching ${DEFAULT_CONFIG_BASENAME}.{${DEFAULT_WORKERD_CONFIG_EXTENSIONS.map((extension) => extension.slice(1)).join(",")}}.`,
		);
	}

	const configPath = path.resolve(root, configFile);
	const loaded = await loadConfigFromFile(env, configPath, root);

	if (!loaded) {
		throw new Error(`Could not load ${configFile}.`);
	}

	return {
		config: parseWorkerdConfig(loaded.config, path.dirname(loaded.path)),
		path: loaded.path,
		dependencies: [...new Set([loaded.path, ...loaded.dependencies])],
	};
}

/**
 * Validates a loaded config object and resolves embedded paths against a base directory.
 */
export function parseWorkerdConfig(config: unknown, baseDirectory: string): WorkerdConfig {
	if (!isPlainObject(config)) {
		throw new Error("workerd config must export an object.");
	}

	if (!Array.isArray(config.services) || !Array.isArray(config.sockets)) {
		throw new Error(`workerd config must include "services" and "sockets" arrays.`);
	}

	const serviceNames = new Set<string>();

	for (const [index, service] of config.services.entries()) {
		if (!isPlainObject(service)) {
			throw new Error(`workerd config service at index ${index} must be an object.`);
		}

		if (typeof service.name !== "string") {
			throw new Error(`workerd config service at index ${index} must include a string \`name\`.`);
		}

		if (serviceNames.has(service.name)) {
			throw new Error(`workerd config must not contain duplicate service names: \`${service.name}\`.`);
		}

		serviceNames.add(service.name);
	}

	const socketNames = new Set<string>();

	for (const [index, socket] of config.sockets.entries()) {
		if (!isPlainObject(socket)) {
			throw new Error(`workerd config socket at index ${index} must be an object.`);
		}

		if (typeof socket.name !== "string") {
			throw new Error(`workerd config socket at index ${index} must include a string \`name\`.`);
		}

		if (socketNames.has(socket.name)) {
			throw new Error(`workerd config must not contain duplicate socket names: \`${socket.name}\`.`);
		}

		socketNames.add(socket.name);
	}

	return normalizeEmbeddedPaths({
		...config,
		services: config.services,
		sockets: config.sockets,
	}, baseDirectory);
}

/**
 * Resolves the base directory used for default workerd config discovery.
 * Vite passes `configFile` into `config()` at runtime even though `UserConfig` doesn't type it.
 */
export function resolveConfigRoot(userConfig: { root?: string; configFile?: string | false }): string {
	const baseDirectory = typeof userConfig.configFile === "string"
		? path.dirname(userConfig.configFile)
		: process.cwd();

	if (typeof userConfig.root === "string") {
		return path.resolve(baseDirectory, userConfig.root);
	}

	return baseDirectory;
}

/**
 * Checks whether a value is a plain object during config validation.
 */
function isPlainObject(
	obj: unknown,
): obj is Record<string | number | symbol, unknown> {
	return (
		!!obj &&
		obj.constructor === Object &&
		Object.getPrototypeOf(obj) === Object.prototype
	);
}

/**
 * Resolves every embedded path in a config tree against a base directory.
 */
function normalizeEmbeddedPaths<Value>(value: Value, baseDirectory: string): Value {
	if (isEmbeddedPath(value)) {
		const embeddedPath = getEmbeddedPath(value);

		if (path.isAbsolute(embeddedPath)) {
			return value;
		}

		return embed(path.resolve(baseDirectory, embeddedPath)) as Value;
	}

	if (Array.isArray(value)) {
		return value.map((item) => normalizeEmbeddedPaths(item, baseDirectory)) as Value;
	}

	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, nestedValue]) => [key, normalizeEmbeddedPaths(nestedValue, baseDirectory)]),
		) as Value;
	}

	return value;
}

/**
 * Finds the first matching `workerd.config.*` file in the given root directory.
 */
function findDefaultConfigFile(root: string): string | undefined {
	for (const extension of DEFAULT_WORKERD_CONFIG_EXTENSIONS) {
		const fileName = `${DEFAULT_CONFIG_BASENAME}${extension}`;
		if (fs.existsSync(path.join(root, fileName))) {
			return fileName;
		}
	}

	return undefined;
}
