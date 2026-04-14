const embedSymbol = Symbol.for("capnp.embed");

export interface EmbeddedPath {
	readonly [embedSymbol]: string;
}

/**
 * Marks a path as a workerd `embed(...)` target.
 */
export function embed(path: string): EmbeddedPath {
	return {
		[embedSymbol]: path,
	};
}

/**
 * Checks whether a value is an embedded path marker.
 */
export function isEmbeddedPath(value: unknown): value is EmbeddedPath {
	return (
		typeof value === "object" &&
		value !== null &&
		embedSymbol in value &&
		typeof value[embedSymbol] === "string"
	);
}

/**
 * Returns the raw path stored in an embedded path marker.
 */
export function getEmbeddedPath(value: EmbeddedPath): string {
	return value[embedSymbol];
}
