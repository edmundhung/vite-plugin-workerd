import { createWorker, type InferEnv, workerEntrypoint } from "../../../../src/index";

import greet from "../greet";

export const bindings = {
	GREET: greet.exports.default(),
};

export type Env = InferEnv<typeof bindings>;

const config = createWorker({
	entry: new URL("./worker.ts", import.meta.url),
	compatibilityDate: "2025-08-01",
	bindings,
	exports: {
		default: workerEntrypoint<typeof import("./worker").default>(),
	},
});

export default config;
