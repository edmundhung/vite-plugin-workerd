import { createWorker, workerEntrypoint } from "../../../../src/index";

const config = createWorker({
	entry: new URL("./worker.ts", import.meta.url),
	compatibilityDate: "2025-08-01",
	exports: {
		default: workerEntrypoint<typeof import("./worker").default>(),
	},
});

export default config;
