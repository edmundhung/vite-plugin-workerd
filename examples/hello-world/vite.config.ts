import { defineConfig } from "vite";

import { workerd } from "vite-plugin-workerd";

export default defineConfig({
	plugins: [workerd()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
