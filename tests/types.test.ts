import { expectTypeOf, it } from "vitest";

import { createWorker, workerEntrypoint } from "../src/index";

it("types worker entrypoint accessors", () => {
	const app = createWorker("./src/index.ts", {
		compatibilityDate: "2025-08-01",
		exports: {
			default: workerEntrypoint(),
			Named: workerEntrypoint<{ issuer: string }>(),
		},
	});

	expectTypeOf(app.exports.default).toBeCallableWith({
		props: {
			issuer: "https://issuer.example",
		},
	});

	expectTypeOf(app.exports.Named).toBeCallableWith({
		props: {
			issuer: "https://issuer.example",
		},
	});

	app.exports.default();

	app.exports.default({
		props: {
			issuer: "https://issuer.example",
		},
	});

	app.exports.Named({
		props: {
			issuer: "https://issuer.example",
		},
	});

	app.exports.Named({
		// @ts-expect-error named entrypoint props should still be type-checked
		props: {},
	});
});
