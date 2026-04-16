import { createWorker, defineConfig } from "vite-plugin-workerd";

const app = createWorker({
	entry: new URL("./src/index.ts", import.meta.url),
	compatibilityDate: "2025-08-01",
});

const port = process.env.WORKERD_PORT ?? "8787";

export default defineConfig({
	sockets: [
		app.listen({
			name: "app",
			address: `*:${port}`,
			protocol: "http",
		}),
	],
});
