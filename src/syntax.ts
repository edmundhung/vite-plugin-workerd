const embedSymbol = Symbol.for("capnp.embed");

export interface EmbeddedPath {
	readonly [embedSymbol]: string;
}

export function embed(path: string): EmbeddedPath {
	return {
		[embedSymbol]: path,
	};
}

export function isEmbeddedPath(value: unknown): value is EmbeddedPath {
	return (
		typeof value === "object" &&
		value !== null &&
		embedSymbol in value &&
		typeof value[embedSymbol] === "string"
	);
}

export function getEmbeddedPath(value: EmbeddedPath): string {
	return value[embedSymbol];
}
