import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"runtime/runner-worker": "src/runtime/runner-worker.ts",
	},
	external: [/^cloudflare:/u],
	fixedExtension: false,
	dts: true,
});
