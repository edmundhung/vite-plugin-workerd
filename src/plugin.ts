import fs from "node:fs";
import path from "node:path";

import { loadConfigFromFile, type ConfigEnv, type Plugin, type ResolvedConfig } from "vite";

import { prepareConfigForSerialization, serializeConfig } from "./serialize";
import type { WorkerdPluginOptions } from "./types";
import type { WorkerdConfig } from "./workerd";

const DEFAULT_CONFIG_BASENAME = "workerd.config";
const DEFAULT_OUTPUT_FILE = "workerd.capnp";
const DEFAULT_WORKERD_CONFIG_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;

export function workerd(options: WorkerdPluginOptions = {}): Plugin {
	let viteConfig: ResolvedConfig | undefined;

	return {
		name: "vite-plugin-workerd",
		apply: "build",
		configResolved(resolvedConfig) {
			viteConfig = resolvedConfig;
		},
		async generateBundle() {
			if (!viteConfig) {
				throw new Error("Vite config was not resolved before generating the workerd config.");
			}

			const loadedConfig = await loadWorkerdConfig(viteConfig.root, viteConfig.mode, options);
			const outputFile = normalizeOutputFile(options.output ?? DEFAULT_OUTPUT_FILE);
			const outputPath = path.resolve(viteConfig.root, viteConfig.build.outDir, outputFile);
			const model = prepareConfigForSerialization(loadedConfig.config, {
				configPath: loadedConfig.path,
				outputPath,
			});
			const source = serializeConfig(model);

			this.emitFile({
				type: "asset",
				fileName: outputFile,
				source,
			});
		},
	};
}

async function loadWorkerdConfig(
	root: string,
	mode: string,
	options: WorkerdPluginOptions,
): Promise<{ path: string; config: WorkerdConfig }> {
	if ("config" in options && options.config !== undefined) {
		const resolvedConfig =
			typeof options.config === "function"
				? await options.config({ mode })
				: options.config;

		return {
			path: path.join(root, "vite.config.ts"),
			config: normalizeLoadedConfig(resolvedConfig),
		};
	}

	const configFile = options.configFile ?? findDefaultConfigFile(root);
	if (!configFile) {
		throw new Error(
			`Could not find a default workerd config file matching ${DEFAULT_CONFIG_BASENAME}.{${DEFAULT_WORKERD_CONFIG_EXTENSIONS.map((extension) => extension.slice(1)).join(",")}}.`,
		);
	}
	const configPath = path.resolve(root, configFile);
	const configEnv: ConfigEnv = {
		command: "build",
		mode,
		isSsrBuild: false,
		isPreview: false,
	};

	const loaded = await loadConfigFromFile(configEnv, configPath, root);
	if (!loaded) {
		throw new Error(`Could not load ${configFile}.`);
	}

	return {
		path: loaded.path,
		config: normalizeLoadedConfig(loaded.config),
	};
}

function normalizeLoadedConfig(config: unknown): WorkerdConfig {
	if (!isRawConfigObject(config)) {
		throw new Error("workerd config must export an object.");
	}

	if (!Array.isArray(config.services)) {
		throw new Error("workerd config must include a `services` array.");
	}

	if (!Array.isArray(config.sockets)) {
		throw new Error("workerd config must include a `sockets` array.");
	}

	for (const [index, service] of config.services.entries()) {
		if (!isRawConfigObject(service)) {
			throw new Error(`workerd config service at index ${index} must be an object.`);
		}
	}

	for (const [index, socket] of config.sockets.entries()) {
		if (!isRawConfigObject(socket)) {
			throw new Error(`workerd config socket at index ${index} must be an object.`);
		}
	}

	return {
		...config,
		services: config.services as WorkerdConfig["services"],
		sockets: config.sockets as WorkerdConfig["sockets"],
	};
}

function isRawConfigObject(
	value: unknown,
): value is { services?: unknown; sockets?: unknown; [key: string]: unknown } {
	return typeof value === "object" && value !== null;
}

function normalizeOutputFile(value: string): string {
	return value.split(path.sep).join("/");
}

function findDefaultConfigFile(root: string): string | undefined {
	for (const extension of DEFAULT_WORKERD_CONFIG_EXTENSIONS) {
		const fileName = `${DEFAULT_CONFIG_BASENAME}${extension}`;
		if (fs.existsSync(path.join(root, fileName))) {
			return fileName;
		}
	}

	return undefined;
}
