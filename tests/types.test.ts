import { expectTypeOf, it } from "vitest";

import type appConfig from "./fixtures/infer-env/app";
import type { bindings as appBindings, Env as FixtureEnv } from "./fixtures/infer-env/app";
import type greetWorker from "./fixtures/infer-env/greet/worker";
import appWorker from "./fixtures/infer-env/app/worker";

import { createWorker, type InferEnv, workerEntrypoint } from "../src/index";

it("types worker entrypoint accessors", () => {
	const app = createWorker({
		entry: new URL("./src/index.ts", import.meta.url),
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

it("types the implicit default worker accessor", () => {
	const app = createWorker({
		entry: new URL("./src/index.ts", import.meta.url),
		compatibilityDate: "2025-08-01",
	});

	expectTypeOf(app.exports.default).toBeCallableWith();
	expectTypeOf(app.exports.default).toBeCallableWith({
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
});

it("infers env bindings from worker definitions", () => {
	type AppEnvFromConfig = InferEnv<typeof appConfig>;
	type AppEnvFromBindings = InferEnv<typeof appBindings>;

	expectTypeOf<Parameters<typeof appWorker.fetch>[1]>().toEqualTypeOf<FixtureEnv>();
	expectTypeOf<Parameters<typeof appWorker.fetch>[1]>().toEqualTypeOf<AppEnvFromBindings>();
	expectTypeOf<Parameters<typeof appWorker.fetch>[1]>().toEqualTypeOf<AppEnvFromConfig>();
	expectTypeOf<FixtureEnv["GREET"]>().toEqualTypeOf<Service<typeof greetWorker>>();
	expectTypeOf<FixtureEnv["GREET"]["fetch"]>().toBeCallableWith(new Request("http://example.com"));
	expectTypeOf<FixtureEnv["GREET"]["greet"]>().toBeCallableWith("Ada");
	expectTypeOf<FixtureEnv["GREET"]["greet"]>().returns.toEqualTypeOf<Promise<string>>();
});
