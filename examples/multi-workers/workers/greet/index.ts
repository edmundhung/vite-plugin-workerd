import { createWorker, workerEntrypoint } from "vite-plugin-workerd";

export default createWorker({
	entry: new URL("./worker.ts", import.meta.url),
	compatibilityDate: "2025-08-01",
	exports: {
		default: workerEntrypoint<typeof import("./worker").default>(),
	},
});
