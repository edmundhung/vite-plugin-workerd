import { createWorker, type InferEnv } from "vite-plugin-workerd";
import greet from "../greet";

export const bindings = {
	GREET: greet.exports.default(),
};

export type Env = InferEnv<typeof bindings>;

export default createWorker({
	entry: new URL("./worker.ts", import.meta.url),
	compatibilityDate: "2025-08-01",
	bindings,
});
