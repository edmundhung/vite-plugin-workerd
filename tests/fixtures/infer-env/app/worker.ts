import type { Env } from "./index";

export default {
	async fetch(_request: Request, env: Env) {
		return new Response(await env.GREET.greet("Ada"));
	},
};
