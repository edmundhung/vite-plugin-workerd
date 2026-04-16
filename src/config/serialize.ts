import path from "node:path";

import { getEmbeddedPath, isEmbeddedPath } from "./syntax";
import type { WorkerdConfig } from "./workerd";

type CapnpScalar = null | boolean | number | string;
type CapnpNode = CapnpScalar | CapnpList | CapnpStruct | CapnpEmbed | CapnpReference;

const INDENT = "  ";
const VOID_FIELD_NAMES = new Set(["ephemeralLocal", "inMemory", "unsafeEval"]);

interface CapnpList extends Array<CapnpNode> {}

interface CapnpStruct {
	[key: string]: CapnpNode | undefined;
}

interface CapnpEmbed {
	$embed: string;
}

interface CapnpReference {
	$ref: string;
}

export interface SerializeConfigOptions {
	outputPath: string;
}

interface SerializeContext {
	outputDir: string;
}

interface RawObject {
	[key: string]: unknown;
}

interface PreparedConfig {
	root: RawObject;
	workers: Array<{ constantName: string; worker: RawObject }>;
}

export interface SerializedConfigModel {
	root: CapnpNode;
	workers: Array<{ constantName: string; worker: CapnpNode }>;
}

/**
 * Prepares a normalized workerd config for Cap'n Proto serialization.
 */
export function prepareConfigForSerialization(
	config: WorkerdConfig,
	options: SerializeConfigOptions,
): SerializedConfigModel {
	const context: SerializeContext = {
		outputDir: path.dirname(options.outputPath),
	};

	const prepared = prepareConfig(config);
	return {
		root: normalizeNode(prepared.root, context),
		workers: prepared.workers.map(({ constantName, worker }) => ({
			constantName,
			worker: normalizeNode(worker, context),
		})),
	};
}

/**
 * Serializes a prepared config model into `workerd.capnp` source text.
 */
export function serializeConfig(model: SerializedConfigModel): string {
	const output = [
		'using Workerd = import "/workerd/workerd.capnp";',
		"",
		`const config :Workerd.Config = ${serializeNode(model.root)};`,
	];

	for (const { constantName, worker } of model.workers) {
		output.push(
			"",
			`const ${constantName} :Workerd.Worker = ${serializeNode(worker)};`,
		);
	}

	return `${output.join("\n")}\n`;
}

/**
 * Replaces worker service bodies with top-level worker constants and references.
 */
function prepareConfig(config: WorkerdConfig): PreparedConfig {
	const services = Array.isArray(config.services) ? config.services : [];
	const workers: Array<{ constantName: string; worker: RawObject }> = [];
	let workerIndex = 1;

	const preparedServices = services.map((service) => {
		if (!isWorkerService(service)) {
			return service;
		}

		const constantName = `worker${workerIndex++}`;
		workers.push({
			constantName,
			worker: service.worker,
		});

		return {
			...service,
			worker: referenceNode(`.${constantName}`),
		};
	});

	return {
		root: {
			...config,
			services: preparedServices,
		},
		workers,
	};
}

/**
 * Normalizes raw config values into serializable Cap'n Proto nodes.
 */
function normalizeNode(
	value: unknown,
	context: SerializeContext,
): CapnpNode {
	if (isEmbeddedPath(value)) {
		return embedNode(
			normalizeSlashes(
				path.relative(
					context.outputDir,
					getEmbeddedPath(value),
				),
			),
		);
	}

	if (isEmbedNode(value) || isReferenceNode(value)) {
		return value;
	}

	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}

	if (typeof value !== "object") {
		throw new Error(`Unsupported Cap'n Proto value type: ${typeof value}`);
	}

	if (Array.isArray(value)) {
		return value.map((item) => normalizeNode(item, context));
	}

	const node: CapnpStruct = {};
	for (const [key, nestedValue] of Object.entries(value)) {
		if (nestedValue === undefined) {
			continue;
		}

		const normalizedValue = normalizeNode(
			nestedValue === true && VOID_FIELD_NAMES.has(key) ? null : nestedValue,
			context,
		);
		if (Array.isArray(normalizedValue) && normalizedValue.length === 0) {
			continue;
		}

		node[key] = normalizedValue;
	}

	return node;
}

/**
 * Serializes a single Cap'n Proto node to a string.
 */
function serializeNode(node: CapnpNode): string {
	return serializeNodeLines(node).join("\n");
}

/**
 * Serializes a node into line-oriented output for nested formatting.
 */
function serializeNodeLines(node: CapnpNode): string[] {
	if (isEmbedNode(node)) {
		return [`embed ${quote(node.$embed)}`];
	}

	if (isReferenceNode(node)) {
		return [node.$ref];
	}

	if (node === null) {
		return ["void"];
	}

	if (Array.isArray(node)) {
		return serializeListLines(node);
	}

	if (typeof node === "object") {
		return serializeStructLines(node);
	}

	if (typeof node === "string") {
		return [quote(node)];
	}

	return [String(node)];
}

/**
 * Serializes a list node using compact or multi-line formatting.
 */
function serializeListLines(node: CapnpList): string[] {
	if (node.length === 0) {
		return ["[]"];
	}

	const itemLines = node.map((item) => serializeNodeLines(item));
	if (node.length === 1 && isCompactNode(node[0])) {
		return [`[ ${itemLines[0][0]} ]`];
	}

	const lines = ["["];
	for (const item of itemLines) {
		lines.push(...withTrailingComma(indentLines(item, 1)));
	}
	lines.push("]");
	return lines;
}

/**
 * Serializes a struct node using compact or multi-line formatting.
 */
function serializeStructLines(node: CapnpStruct): string[] {
	const fields = Object.entries(node).filter(
		(entry): entry is [string, CapnpNode] => entry[1] !== undefined,
	);
	if (fields.length === 0) {
		return ["()"];
	}

	const fieldLines = fields.map(([key, value]) => serializeFieldLines(key, value));
	if (fields.length === 1 && isCompactNode(fields[0][1])) {
		return [`( ${fieldLines[0][0]} )`];
	}

	const lines = ["("];
	for (const field of fieldLines) {
		lines.push(...withTrailingComma(indentLines(field, 1)));
	}
	lines.push(")");
	return lines;
}

/**
 * Serializes a single struct field.
 */
function serializeFieldLines(name: string, value: CapnpNode): string[] {
	const valueLines = serializeNodeLines(value);
	if (valueLines.length === 1) {
		return [`${name} = ${valueLines[0]}`];
	}

	return [`${name} = ${valueLines[0]}`, ...indentLines(valueLines.slice(1), 1)];
}

/**
 * Indents serialized lines by the requested nesting level.
 */
function indentLines(lines: string[], level: number): string[] {
	const prefix = INDENT.repeat(level);
	return lines.map((line) => `${prefix}${line}`);
}

/**
 * Adds a trailing comma to the last line of a serialized block.
 */
function withTrailingComma(lines: string[]): string[] {
	return lines.map((line, index) =>
		index === lines.length - 1 ? `${line},` : line,
	);
}

/**
 * Checks whether a node serializes as a single scalar, embed, or reference value.
 */
function isLeafNode(node: CapnpNode): boolean {
	return (
		node === null ||
		typeof node === "string" ||
		typeof node === "number" ||
		typeof node === "boolean" ||
		isEmbedNode(node) ||
		isReferenceNode(node)
	);
}

/**
 * Checks whether a node can stay on one line in serialized output.
 */
function isCompactNode(node: CapnpNode): boolean {
	if (isLeafNode(node)) {
		return true;
	}

	if (Array.isArray(node)) {
		return node.length === 0 || (node.length === 1 && isCompactNode(node[0]));
	}

	if (node !== null && typeof node === "object" && !isEmbedNode(node) && !isReferenceNode(node)) {
		const fields = Object.values(node).filter(
			(value): value is CapnpNode => value !== undefined,
		);
		return fields.length === 0 || (fields.length === 1 && isCompactNode(fields[0]));
	}

	return false;
}

/**
 * Wraps an embed string as a serialization node.
 */
function embedNode(value: string): CapnpEmbed {
	return { $embed: value };
}

/**
 * Wraps a constant reference as a serialization node.
 */
function referenceNode(value: string): CapnpReference {
	return { $ref: value };
}

/**
 * Checks whether a value is a raw object-like config node.
 */
function isRawObject(value: unknown): value is RawObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks whether a raw service record contains a worker.
 */
function isWorkerService(value: unknown): value is { name: unknown; worker: RawObject } {
	return isRawObject(value) && "worker" in value && isRawObject(value.worker);
}

/**
 * Checks whether a node is an embed placeholder.
 */
function isEmbedNode(value: unknown): value is CapnpEmbed {
	return typeof value === "object" && value !== null && "$embed" in value;
}

/**
 * Checks whether a node is a constant reference placeholder.
 */
function isReferenceNode(value: unknown): value is CapnpReference {
	return typeof value === "object" && value !== null && "$ref" in value;
}

/**
 * Quotes a string for Cap'n Proto output using JSON escaping rules.
 */
function quote(value: string): string {
	return JSON.stringify(value);
}

/**
 * Normalizes paths to forward slashes for stable serialized embed paths.
 */
function normalizeSlashes(value: string): string {
	return value.split(path.sep).join("/");
}
