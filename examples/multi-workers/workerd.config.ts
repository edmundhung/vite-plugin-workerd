import { defineConfig } from "vite-plugin-workerd";
import app from "./workers/app";

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
