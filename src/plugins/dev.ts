import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { builtinModules } from "node:module";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

import {
	normalizePath,
	type DevEnvironment,
	type EnvironmentModuleNode,
	type HotChannelClient,
	type Plugin,
	type ViteDevServer,
} from "vite";

import {
	createBuildContext,
	type WorkerdBuildContext,
	type WorkerTarget,
} from "./build";
import { loadWorkerdConfig, resolveConfigRoot, type LoadedWorkerdConfig } from "../config/load";
import {
	createDevConfig,
	createDevControlModuleSource,
	createDevWrapperModuleSource,
	collectReferencedEntrypoints,
	loadRunnerWorkerModuleSource,
	resolveDevOutputDirectory,
	resolveHotWorkerTarget,
	resolveSocketRoutes,
	writeDevConfig,
} from "../config/dev";
import {
	WorkerdDevEnvironment,
	createWorkerdDevEnvironmentOptions,
	createWorkerdLoaderEnvironmentOptions,
	getWorkerdLoaderEnvironmentName,
} from "./dev-environment";
import { createWorkerdRuntime, type WorkerdDevRuntime } from "./process";
import {
	INVALIDATE_WORKER_CODE_EVENT,
	INIT_PATH,
	RESOLVE_WORKER_CODE_EVENT,
	RESOLVE_WORKER_CODE_RESULT_EVENT,
	type ResolveWorkerCodeRequest,
	type WorkerLoaderCodePayload,
} from "../runtime/shared";
import type { WorkerdPluginOptions } from "./types";
import type { WorkerConfig, WorkerdService } from "../config/workerd";

const INTERNAL_WORKERD_HOST = "127.0.0.1";
const VITE_HMR_PROTOCOL = "vite-hmr";
const NODE_BUILTIN_IDS = new Set(
	builtinModules.flatMap((id) => [id, id.startsWith("node:") ? id.slice(5) : `node:${id}`]),
);

export interface WorkerdDevPluginContext {
	hotTarget?: WorkerTarget;
}

const kWorkerdDevRuntime = Symbol("vite-plugin-workerd.dev-runtime");

interface WorkerdDevServerWithRuntime extends ViteDevServer {
	[kWorkerdDevRuntime]?: WorkerdDevRuntime;
}

/**
 * Returns the active workerd runtime for tests and local diagnostics.
 */
export function getWorkerdDevRuntime(server: ViteDevServer): WorkerdDevRuntime | undefined {
	return (server as WorkerdDevServerWithRuntime)[kWorkerdDevRuntime];
}

/**
 * Creates the serve-only plugin that runs a real workerd process behind Vite.
 */
export function createWorkerdDevPlugin(
	options: WorkerdPluginOptions,
	context: WorkerdDevPluginContext,
): Plugin {
	let loadedWorkerdConfig!: LoadedWorkerdConfig;
	let buildContext!: WorkerdBuildContext;

	return {
		name: "vite-plugin-workerd:dev",
		apply: "serve",
		async config(userConfig, env) {
			const root = resolveConfigRoot(userConfig);
			loadedWorkerdConfig = await loadWorkerdConfig(options, root, env);
			buildContext = createBuildContext({
				root,
				outDir: resolveDevOutputDirectory(root, userConfig.cacheDir ?? "node_modules/.vite"),
				outputFileName: createDevWorkerdConfigFileName(),
				config: loadedWorkerdConfig.config,
			});
			context.hotTarget = resolveHotWorkerTarget(buildContext, options.defaultSocket);

			return {
				appType: "custom",
				environments: {
					[context.hotTarget.environmentName]: createWorkerdDevEnvironmentOptions(context.hotTarget),
					...Object.fromEntries(
						buildContext.workerTargets.map((target) => [
							getWorkerdLoaderEnvironmentName(target),
							createWorkerdLoaderEnvironmentOptions(target),
						]),
					),
				},
			};
		},
		async configureServer(server) {
			const controlTarget = context.hotTarget;
			if (!controlTarget) {
				throw new Error("Expected a hot worker target to be resolved before configureServer().");
			}

			const runtimeModuleSource = await loadRunnerWorkerModuleSource();
			const runtimeModuleSpecifier = "./runner-worker.js";
			const controlModuleSource = createDevControlModuleSource({
				runtimeModuleSpecifier,
			});
			const wrapperModuleSourcesByService = new Map(
				buildContext.workerTargets.map((target) => [
					target.serviceName,
					createDevWrapperModuleSource({
						serviceName: target.serviceName,
						runtimeModuleSpecifier,
						entrypointNames: collectReferencedEntrypoints(
							loadedWorkerdConfig.config,
							target.serviceName,
						),
					}),
				]),
			);
			const socketRoutes = resolveSocketRoutes(loadedWorkerdConfig.config, options.defaultSocket);
			const { config: devConfig, controlSocketName } = createDevConfig({
				context: buildContext,
				controlTarget,
				runtimeModuleSource,
				controlModuleSource,
				wrapperModuleSourcesByService,
			});

			writeDevConfig(buildContext.outputPath, devConfig);

			const routes = new Map(socketRoutes.routes);
			routes.set(controlSocketName, { name: controlSocketName, protocol: "http" });

			const runtime = createWorkerdRuntime({
				root: server.config.root,
				configPath: buildContext.outputPath,
				routes,
				logger: server.config.logger,
			});

			await runtime.restart();
			(server as WorkerdDevServerWithRuntime)[kWorkerdDevRuntime] = runtime;

			const controlSocketTarget = runtime.resolve(controlSocketName);
			if (!controlSocketTarget) {
				throw new Error("workerd did not expose the internal control socket.");
			}

			const environment = server.environments[controlTarget.environmentName] as WorkerdDevEnvironment | undefined;
			if (!environment) {
				throw new Error(`Expected Vite environment ${JSON.stringify(controlTarget.environmentName)} to be defined.`);
			}
			const workerTargetsByService = new Map(buildContext.workerTargets.map((target) => [target.serviceName, target]));
			const loaderEnvironmentsByService = new Map(
				buildContext.workerTargets.map((target) => {
					const loaderEnvironment = server.environments[getWorkerdLoaderEnvironmentName(target)] as DevEnvironment | undefined;
					if (!loaderEnvironment) {
						throw new Error(
							`Expected Vite environment ${JSON.stringify(getWorkerdLoaderEnvironmentName(target))} to be defined.`,
						);
					}

					return [target.serviceName, loaderEnvironment] as const;
				}),
			);
			const workerConfigsByService = new Map(
				buildContext.workerTargets.map((target) => [
					target.serviceName,
					getHotWorkerConfig(loadedWorkerdConfig.config, target.serviceName),
				]),
			);
			const handleResolveWorkerCode = async (
				data: unknown,
				client: HotChannelClient,
			) => {
				if (!isResolveWorkerCodeRequest(data)) {
					return;
				}

				const target = workerTargetsByService.get(data.serviceName);
				const loaderEnvironment = loaderEnvironmentsByService.get(data.serviceName);
				const workerConfig = workerConfigsByService.get(data.serviceName);
				if (!target || !loaderEnvironment || !workerConfig) {
					client.send({
						type: "custom",
						event: RESOLVE_WORKER_CODE_RESULT_EVENT,
						data: {
							requestId: data.requestId,
							serviceName: data.serviceName,
							error: `Unknown worker service ${JSON.stringify(data.serviceName)}.`,
						},
					});
					return;
				}

				try {
					const code = await materializeWorkerLoaderCode({
						environment: loaderEnvironment,
						root: server.config.root,
						target,
						worker: workerConfig,
					});
					client.send({
						type: "custom",
						event: RESOLVE_WORKER_CODE_RESULT_EVENT,
						data: {
							requestId: data.requestId,
							serviceName: data.serviceName,
							code,
						},
					});
				} catch (error) {
					client.send({
						type: "custom",
						event: RESOLVE_WORKER_CODE_RESULT_EVENT,
						data: {
							requestId: data.requestId,
							serviceName: data.serviceName,
							error: formatError(error),
						},
					});
				}
			};
			environment.hot.on(RESOLVE_WORKER_CODE_EVENT, handleResolveWorkerCode);

			await environment.initRunner(`ws://${INTERNAL_WORKERD_HOST}:${controlSocketTarget.port}${INIT_PATH}`);

			const workerdConfigDependencies = new Set(loadedWorkerdConfig.dependencies);
			if (workerdConfigDependencies.size > 0) {
				server.watcher.add([...workerdConfigDependencies]);
			}

			const restartForConfigChange = async (changedFile: string) => {
				if (!workerdConfigDependencies.has(changedFile)) {
					return;
				}

				server.config.logger.info("\nworkerd config changed, restarting Vite dev server...");
				await server.restart();
			};
			const invalidateWorkerCode = (changedFile: string) => {
				if (workerdConfigDependencies.has(changedFile)) {
					return;
				}

				environment.hot.send(INVALIDATE_WORKER_CODE_EVENT);
			};

			server.watcher.on("add", invalidateWorkerCode);
			server.watcher.on("change", restartForConfigChange);
			server.watcher.on("change", invalidateWorkerCode);
			server.watcher.on("unlink", invalidateWorkerCode);
			server.watcher.on("unlink", restartForConfigChange);

			let cleanedUp = false;
			const cleanup = async () => {
				if (cleanedUp) {
					return;
				}

				cleanedUp = true;
				environment.hot.off(RESOLVE_WORKER_CODE_EVENT, handleResolveWorkerCode);
				server.watcher.off("add", invalidateWorkerCode);
				server.watcher.off("change", restartForConfigChange);
				server.watcher.off("change", invalidateWorkerCode);
				server.watcher.off("unlink", invalidateWorkerCode);
				server.watcher.off("unlink", restartForConfigChange);
				(server as WorkerdDevServerWithRuntime)[kWorkerdDevRuntime] = undefined;
				await runtime.close();
			};

			server.httpServer?.once("close", () => {
				void cleanup();
			});

			return () => {
				const removeProxyMiddleware = installWorkerdProxyMiddleware(
					server,
					runtime,
					socketRoutes.defaultSocketName,
				);
				const removeUpgradeHandler = installWorkerdUpgradeHandler(
					server,
					runtime,
					socketRoutes.defaultSocketName,
				);

				server.httpServer?.once("close", () => {
					removeProxyMiddleware();
					removeUpgradeHandler();
				});
			};
		},
	};
}

/**
 * Creates a per-session dev config filename to avoid collisions between concurrent Vite sessions.
 */
function createDevWorkerdConfigFileName(): string {
	const sessionId = randomBytes(3).toString("hex");

	return `workerd.${sessionId}.capnp`;
}

/**
 * Materializes the hot worker into a workerLoader-compatible module graph.
 */
async function materializeWorkerLoaderCode(options: {
	environment: DevEnvironment;
	root: string;
	target: WorkerTarget;
	worker: WorkerConfig;
}): Promise<WorkerLoaderCodePayload> {
	const entryUrl = toEnvironmentUrl(options.root, options.target.entryPath);
	const modulesByUrl = new Map<string, EnvironmentModuleNode>();

	await collectTransformedModules(options.environment, options.root, entryUrl, modulesByUrl);
	const transformedCodeByUrl = new Map(
		await Promise.all(
			[...modulesByUrl.entries()].map(async ([url, module]) => {
				const transformed = module.transformResult ?? await options.environment.transformRequest(url);
				if (!transformed) {
					throw new Error(`Vite did not return a transform result for ${JSON.stringify(url)}.`);
				}

				return [url, transformed.code] as const;
			}),
		),
	);

	const moduleNames = new Map<string, string>(
		[...modulesByUrl.keys()].map((url) => [
			url,
			url === entryUrl ? "main.js" : `./${createHash("sha1").update(url).digest("hex").slice(0, 8)}.js`,
		]),
	);
	const modules = Object.fromEntries(
		await Promise.all(
			[...modulesByUrl.entries()].map(async ([url, module]) => {
				let code = normalizeViteExternalSpecifiers(transformedCodeByUrl.get(url)!);
				for (const linkedModule of getLinkedModules(options.root, module, code)) {
					const importedModule = modulesByUrl.get(linkedModule.url);
					if (!importedModule) {
						continue;
					}

					const externalWorkerSpecifier = getExternalWorkerSpecifier(linkedModule.specifier);
					if (externalWorkerSpecifier) {
						code = replaceModuleSpecifier(code, linkedModule.specifier, externalWorkerSpecifier);
						continue;
					}

					const requestedNamedImports = extractNamedImportsForSpecifier(code, linkedModule.specifier);
					if (requestedNamedImports.length > 0) {
						const importedCode = transformedCodeByUrl.get(linkedModule.url);
						if (importedCode) {
							const existingNamedExports = getExistingNamedExports(importedCode);
							if (requestedNamedImports.some((name) => !existingNamedExports.has(name))) {
								code = rewriteNamedImportForInterop(code, linkedModule.specifier);
							}
						}
					}

					const normalizedSpecifier = moduleNames.get(linkedModule.url);
					if (!normalizedSpecifier) {
						continue;
					}

					code = replaceModuleSpecifier(code, linkedModule.specifier, normalizedSpecifier);
				}

				return [
					moduleNames.get(url)!,
					looksLikeCommonJsModule(code)
						? { cjs: code }
						: { js: code },
				];
			}),
		),
	) as WorkerLoaderCodePayload["modules"];
	const compatibilityFlags = ensureWorkerLoaderCompatibilityFlags(options.worker.compatibilityFlags);
	const compatibilityDate = options.worker.compatibilityDate;
	if (!compatibilityDate) {
		throw new Error(
			`Worker service ${JSON.stringify(options.target.serviceName)} must define a compatibilityDate for vite dev.`,
		);
	}

	const generation = createHash("sha1")
		.update(JSON.stringify({
			compatibilityDate,
			compatibilityFlags,
			modules: Object.entries(modules).sort(([left], [right]) => left.localeCompare(right)),
		}))
		.digest("hex");

	return {
		generation,
		compatibilityDate,
		compatibilityFlags,
		allowExperimental: true,
		mainModule: moduleNames.get(entryUrl)!,
		modules,
	};
}

/**
 * Recursively transforms the entry module and records every workerLoader-relevant module node.
 */
async function collectTransformedModules(
	environment: DevEnvironment,
	root: string,
	url: string,
	modulesByUrl: Map<string, EnvironmentModuleNode>,
): Promise<void> {
	if (modulesByUrl.has(url) || isExternalWorkerModule(url)) {
		return;
	}

	const transformed = await environment.transformRequest(url);
	if (!transformed) {
		throw new Error(`Vite did not return a transform result for ${JSON.stringify(url)}.`);
	}

	await environment.waitForRequestsIdle(url);

	const module = await environment.moduleGraph.getModuleByUrl(url);
	if (!module) {
		throw new Error(`Could not find ${JSON.stringify(url)} in the Vite module graph.`);
	}

	if (module.type !== "js") {
		throw new Error(
			`vite dev workerLoader materialization only supports JavaScript modules for now. Got ${JSON.stringify(module.type)} from ${JSON.stringify(url)}.`,
		);
	}

	modulesByUrl.set(url, module);

	for (const importedModule of module.importedModules) {
		await collectTransformedModules(environment, root, importedModule.url, modulesByUrl);
	}

	const transformedCode = module.transformResult?.code ?? transformed.code;
	for (const dependency of getCommonJsDependencies(root, module, transformedCode)) {
		await collectTransformedModules(environment, root, dependency.url, modulesByUrl);
	}
}

/**
 * Resolves a source file path into the served URL used by a Vite dev environment.
 */
function toEnvironmentUrl(root: string, filePath: string): string {
	const normalizedFilePath = normalizePath(filePath);
	const relativePath = normalizePath(path.relative(root, normalizedFilePath));

	if (!relativePath.startsWith("../") && !path.isAbsolute(relativePath)) {
		return `/${relativePath}`;
	}

	return `/@fs/${normalizedFilePath}`;
}

/**
 * Rewrites an emitted Vite module specifier to its workerLoader-safe normalized name.
 */
function replaceModuleSpecifier(code: string, originalSpecifier: string, nextSpecifier: string): string {
	let updatedCode = code;

	for (const variant of getSpecifierVariants(originalSpecifier)) {
		const escapedSpecifier = escapeRegExp(variant);
		updatedCode = updatedCode.replace(
			new RegExp(`(["'])${escapedSpecifier}(?:\\?[^"']*)?\\1`, "g"),
			JSON.stringify(nextSpecifier),
		);
	}

	return updatedCode;
}

/**
 * Ensures dynamic workers get the flag needed for ctx.exports-based entrypoint calls.
 */
function ensureWorkerLoaderCompatibilityFlags(flags: string[] | undefined): string[] {
	return [...new Set([...(flags ?? []), "enable_ctx_exports"])];
}

/**
 * Checks whether a module import should stay external to the generated workerLoader graph.
 */
function isExternalWorkerModule(url: string): boolean {
	return getExternalWorkerSpecifier(url) !== undefined;
}

/**
 * Returns every linked dependency for a transformed module, including static CommonJS requires.
 */
function getLinkedModules(
	root: string,
	module: EnvironmentModuleNode,
	code: string,
): Array<{ url: string; specifier: string }> {
	const linkedModules = new Map<string, { url: string; specifier: string }>(
		[...module.importedModules].map((importedModule) => [
			importedModule.url,
			{ url: importedModule.url, specifier: importedModule.url },
		]),
	);

	for (const dependency of getCommonJsDependencies(root, module, code)) {
		linkedModules.set(dependency.url, dependency);
	}

	return [...linkedModules.values()];
}

/**
 * Resolves static CommonJS requires into Vite-served urls for workerLoader materialization.
 */
function getCommonJsDependencies(
	root: string,
	module: EnvironmentModuleNode,
	code: string,
): Array<{ url: string; specifier: string }> {
	if (!looksLikeCommonJsModule(code) || !module.file) {
		return [];
	}

	const dependencies = new Map<string, { url: string; specifier: string }>();
	const moduleDirectory = path.dirname(module.file);

	for (const requiredSpecifier of extractCommonJsRequires(code)) {
		if (getExternalWorkerSpecifier(requiredSpecifier)) {
			continue;
		}

		let resolvedFilePath: string;
		if (requiredSpecifier.startsWith(".") || requiredSpecifier.startsWith("/")) {
			resolvedFilePath = resolveCommonJsFile(path.resolve(moduleDirectory, requiredSpecifier));
		} else {
			resolvedFilePath = require.resolve(requiredSpecifier, { paths: [moduleDirectory] });
		}

		const dependencyUrl = toEnvironmentUrl(root, resolvedFilePath);
		dependencies.set(dependencyUrl, {
			url: dependencyUrl,
			specifier: requiredSpecifier,
		});
	}

	return [...dependencies.values()];
}

/**
 * Extracts static `require("...")` calls from CommonJS source.
 */
function extractCommonJsRequires(code: string): string[] {
	const requiredSpecifiers = new Set<string>();

	for (const match of code.matchAll(/\brequire\((['"])([^'"]+)\1\)/gu)) {
		requiredSpecifiers.add(match[2]);
	}

	return [...requiredSpecifiers];
}

/**
 * Resolves a CommonJS dependency path using the common Node file-resolution patterns.
 */
function resolveCommonJsFile(filePath: string): string {
	const candidates = [
		filePath,
		`${filePath}.js`,
		`${filePath}.json`,
		path.join(filePath, "index.js"),
		path.join(filePath, "index.json"),
	];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	throw new Error(`Could not resolve CommonJS dependency ${JSON.stringify(filePath)} for vite dev workerLoader materialization.`);
}

/**
 * Detects CommonJS-style source that should be emitted as a workerLoader `cjs` module.
 */
function looksLikeCommonJsModule(code: string): boolean {
	return /\bmodule\.exports\b|(?<![.$\w])exports\.|\brequire\((['"])/u.test(code);
}

/**
 * Resolves a collected Vite module id to the external runtime specifier workerd should see.
 */
function getExternalWorkerSpecifier(url: string): string | undefined {
	const normalizedUrl = stripQuery(url);
	if (normalizedUrl === "cloudflare:workers" || normalizedUrl.startsWith("cloudflare:")) {
		return normalizedUrl;
	}

	if (NODE_BUILTIN_IDS.has(normalizedUrl)) {
		return normalizedUrl;
	}

	if (normalizedUrl.startsWith("/@id/")) {
		const decodedSpecifier = normalizedUrl.slice("/@id/".length).replace(/^__x00__/u, "");
		if (decodedSpecifier.startsWith("cloudflare:")) {
			return decodedSpecifier;
		}
		if (NODE_BUILTIN_IDS.has(decodedSpecifier)) {
			return decodedSpecifier;
		}
	}

	return undefined;
}

/**
 * Collects named imports requested from each module so default-only modules can synthesize them.
 */
function collectRequestedInteropExports(
	modulesByUrl: Map<string, EnvironmentModuleNode>,
): Map<string, string[]> {
	const requestedExportsByUrl = new Map<string, Set<string>>();

	for (const module of modulesByUrl.values()) {
		const transformedCode = module.transformResult?.code;

		for (const [importedId, bindings] of module.importedBindings ?? []) {
			const importedModule = [...module.importedModules].find((candidate) =>
				matchesModuleIdentifier(candidate, importedId),
			);
			if (!importedModule) {
				continue;
			}

			for (const binding of bindings) {
				if (binding === "default" || binding === "*" || !isValidIdentifier(binding)) {
					continue;
				}

				const requestedExports = requestedExportsByUrl.get(importedModule.url) ?? new Set<string>();
				requestedExports.add(binding);
				requestedExportsByUrl.set(importedModule.url, requestedExports);
			}
		}

		if (!transformedCode) {
			continue;
		}

		for (const importedModule of module.importedModules) {
			for (const binding of extractNamedImportsForSpecifier(transformedCode, importedModule.url)) {
				const requestedExports = requestedExportsByUrl.get(importedModule.url) ?? new Set<string>();
				requestedExports.add(binding);
				requestedExportsByUrl.set(importedModule.url, requestedExports);
			}
		}
	}

	return new Map(
		[...requestedExportsByUrl.entries()].map(([url, requestedExports]) => [url, [...requestedExports]]),
	);
}

/**
 * Extracts straightforward named exports from transformed ESM so we don't synthesize duplicates.
 */
function getExistingNamedExports(code: string): Set<string> {
	const exportNames = new Set<string>();

	for (const match of code.matchAll(/export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gu)) {
		exportNames.add(match[1]);
	}

	for (const match of code.matchAll(/export\s*\{([^}]+)\}/gu)) {
		for (const specifier of match[1].split(",")) {
			const exportedName = specifier.split(/\s+as\s+/u).pop()?.trim();
			if (exportedName && isValidIdentifier(exportedName)) {
				exportNames.add(exportedName);
			}
		}
	}

	return exportNames;
}

/**
 * Checks whether a string is safe to use as a JavaScript named export.
 */
function isValidIdentifier(value: string): boolean {
	return /^[A-Za-z_$][\w$]*$/u.test(value);
}

/**
 * Matches one of the identifier shapes Vite may use for importedBindings entries.
 */
function matchesModuleIdentifier(module: EnvironmentModuleNode, identifier: string): boolean {
	const normalizedIdentifier = stripQuery(identifier);
	return [module.url, module.id, module.file]
		.filter((value): value is string => !!value)
		.some((value) => value === identifier || value === normalizedIdentifier || stripQuery(value) === normalizedIdentifier);
}

/**
 * Removes a Vite query suffix when matching module ids.
 */
function stripQuery(value: string): string {
	const queryIndex = value.indexOf("?");
	return queryIndex === -1 ? value : value.slice(0, queryIndex);
}

/**
 * Returns the import-specifier variants Vite may emit for the same resolved module.
 */
function getSpecifierVariants(specifier: string): string[] {
	const strippedSpecifier = stripQuery(specifier);
	const variants = new Set([specifier, strippedSpecifier]);

	if (strippedSpecifier.startsWith("/@id/")) {
		variants.add(strippedSpecifier.slice(1));
	}

	return [...variants];
}

/**
 * Rewrites Vite internal builtin ids like `@id/module` into runtime-resolvable specifiers.
 */
function normalizeViteExternalSpecifiers(code: string): string {
	return code.replace(/(["'])\/?@id\/(?:__x00__)?([^"']+)\1/gu, (match, quote: string, encodedSpecifier: string) => {
		const runtimeSpecifier = getExternalWorkerSpecifier(`/@id/${encodedSpecifier}`);
		return runtimeSpecifier ? `${quote}${runtimeSpecifier}${quote}` : match;
	});
}

/**
 * Extracts named import bindings for a specific module specifier from transformed ESM.
 */
function extractNamedImportsForSpecifier(code: string, specifier: string): string[] {
	const escapedSpecifier = escapeRegExp(stripQuery(specifier));
	const pattern = new RegExp(
		`import\\s+(?:[^,{]+,\\s*)?\\{([^}]+)\\}\\s+from\\s+(["'])${escapedSpecifier}(?:\\?[^"']*)?\\2`,
		"gu",
	);
	const bindings = new Set<string>();

	for (const match of code.matchAll(pattern)) {
		for (const specifierPart of match[1].split(",")) {
			const importedName = specifierPart.split(/\s+as\s+/u)[0]?.trim();
			if (importedName && importedName !== "default" && importedName !== "*" && isValidIdentifier(importedName)) {
				bindings.add(importedName);
			}
		}
	}

	return [...bindings];
}

/**
 * Rewrites a named import into default-import-plus-destructure for default-only interop modules.
 */
function rewriteNamedImportForInterop(code: string, specifier: string): string {
	const escapedSpecifier = escapeRegExp(stripQuery(specifier));
	const pattern = new RegExp(
		`import\\s+(?:([A-Za-z_$][\\w$]*)\\s*,\\s*)?\\{([^}]+)\\}\\s+from\\s+(["'])${escapedSpecifier}(?:\\?[^"']*)?\\3`,
		"u",
	);

	return code.replace(pattern, (_, defaultImport: string | undefined, namedSpecifiers: string, quote: string) => {
		const defaultBinding = defaultImport || `__vite_plugin_workerd_interop_${createHash("sha1").update(specifier).digest("hex").slice(0, 8)}`;
		const destructuredBindings = namedSpecifiers
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => {
				const [importedName, localName] = part.split(/\s+as\s+/u).map((value) => value.trim());
				return localName ? `${importedName}: ${localName}` : importedName;
			})
			.join(", ");

		return `import ${defaultBinding} from ${quote}${specifier}${quote}; const { ${destructuredBindings} } = ${defaultBinding}`;
	});
}

/**
 * Looks up the source worker config for the hot service.
 */
function getHotWorkerConfig(config: LoadedWorkerdConfig["config"], serviceName: string): WorkerConfig {
	const service = config.services.find(
		(candidate): candidate is Extract<WorkerdService, { worker: WorkerConfig }> =>
			candidate.name === serviceName && "worker" in candidate,
	);
	if (!service) {
		throw new Error(`Could not find worker service ${JSON.stringify(serviceName)} in the loaded workerd config.`);
	}

	return service.worker;
}

/**
 * Checks whether a custom hot payload is a worker-code request.
 */
function isResolveWorkerCodeRequest(data: unknown): data is ResolveWorkerCodeRequest {
	return (
		!!data &&
		typeof data === "object" &&
		typeof (data as Record<string, unknown>).requestId === "string" &&
		typeof (data as Record<string, unknown>).serviceName === "string"
	);
}

/**
 * Converts an arbitrary error into a string for transport back into workerd.
 */
function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.stack ?? error.message;
	}

	return String(error);
}

/**
 * Escapes special characters so a string can be used in a RegExp literal.
 */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Installs the post middleware that proxies unmatched HTTP requests into workerd.
 */
function installWorkerdProxyMiddleware(
	server: ViteDevServer,
	runtime: WorkerdDevRuntime,
	defaultSocketName: string,
): () => void {
	const middleware = (
		req: http.IncomingMessage,
		res: http.ServerResponse,
		next: (error?: unknown) => void,
	) => {
		const socketName = getSocketNameForRequest(req, defaultSocketName);
		if (!socketName) {
			next();
			return;
		}

		const target = runtime.resolve(socketName);
		if (!target) {
			res.statusCode = 503;
			res.end(`workerd socket ${JSON.stringify(socketName)} is not ready.`);
			return;
		}

		proxyHttpRequest(req, res, target).catch(next);
	};

	server.middlewares.use(middleware);

	return () => {
		const stack = server.middlewares.stack;
		const index = stack.findIndex((entry) => entry.handle === middleware);
		if (index !== -1) {
			stack.splice(index, 1);
		}
	};
}

/**
 * Installs a raw upgrade proxy for non-Vite WebSocket traffic.
 */
function installWorkerdUpgradeHandler(
	server: ViteDevServer,
	runtime: WorkerdDevRuntime,
	defaultSocketName: string,
): () => void {
	const httpServer = server.httpServer;
	if (!httpServer) {
		return () => {};
	}

	const handler = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
		const protocols = req.headers["sec-websocket-protocol"];
		if (
			typeof protocols === "string" &&
			protocols.split(",").some((protocol) => protocol.trim() === VITE_HMR_PROTOCOL)
		) {
			return;
		}

		const socketName = getSocketNameForRequest(req, defaultSocketName);
		if (!socketName) {
			return;
		}

		const target = runtime.resolve(socketName);
		if (!target) {
			socket.destroy();
			return;
		}

		proxyUpgradeRequest(req, socket, head, target);
	};

	httpServer.on("upgrade", handler);

	return () => {
		httpServer.off("upgrade", handler);
	};
}

/**
 * Resolves the socket name for a proxied request based on the incoming host header.
 */
function getSocketNameForRequest(
	req: http.IncomingMessage,
	defaultSocketName: string,
): string | undefined {
	const hostHeader = req.headers.host;
	if (!hostHeader) {
		return undefined;
	}

	const hostname = hostHeader.replace(/:\d+$/, "").toLowerCase();
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "[::1]" ||
		hostname === "::1"
	) {
		return defaultSocketName;
	}

	if (!hostname.endsWith(".localhost")) {
		return undefined;
	}

	return hostname.slice(0, -".localhost".length) || undefined;
}

/**
 * Proxies an HTTP request into the selected workerd socket.
 */
async function proxyHttpRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	target: { protocol: "http" | "https"; port: number },
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const upstreamRequest = target.protocol === "https"
			? https.request(
				{
					hostname: INTERNAL_WORKERD_HOST,
					port: target.port,
					method: req.method,
					path: req.url,
					headers: req.headers,
					rejectUnauthorized: false,
				},
				(upstreamResponse) => {
					res.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
					upstreamResponse.pipe(res);
					upstreamResponse.on("end", resolve);
				},
			)
			: http.request(
				{
					hostname: INTERNAL_WORKERD_HOST,
					port: target.port,
					method: req.method,
					path: req.url,
					headers: req.headers,
				},
				(upstreamResponse) => {
					res.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
					upstreamResponse.pipe(res);
					upstreamResponse.on("end", resolve);
				},
			);

		upstreamRequest.on("error", reject);
		req.on("aborted", () => {
			upstreamRequest.destroy();
		});

		if (req.readableEnded) {
			upstreamRequest.end();
			return;
		}

		req.pipe(upstreamRequest);
	});
}

/**
 * Proxies a WebSocket upgrade request into the selected workerd socket.
 */
function proxyUpgradeRequest(
	req: http.IncomingMessage,
	clientSocket: net.Socket,
	head: Buffer,
	target: { protocol: "http" | "https"; port: number },
): void {
	const upstreamSocket = target.protocol === "https"
		? tls.connect({
			host: INTERNAL_WORKERD_HOST,
			port: target.port,
			rejectUnauthorized: false,
		})
		: net.connect({
			host: INTERNAL_WORKERD_HOST,
			port: target.port,
		});

	upstreamSocket.on("connect", () => {
		const requestLines = [
			`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`,
		];

		for (let index = 0; index < req.rawHeaders.length; index += 2) {
			requestLines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
		}

		upstreamSocket.write(`${requestLines.join("\r\n")}\r\n\r\n`);
		if (head.length > 0) {
			upstreamSocket.write(head);
		}

		clientSocket.pipe(upstreamSocket).pipe(clientSocket);
	});

	const onError = () => {
		clientSocket.destroy();
		upstreamSocket.destroy();
	};

	clientSocket.on("error", onError);
	upstreamSocket.on("error", onError);
}
