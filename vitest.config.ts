import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.spec.ts"],
		exclude: ["dist/**", "node_modules/**"],
	},
});
