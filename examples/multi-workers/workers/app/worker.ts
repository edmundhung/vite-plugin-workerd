import type { Env } from "./index";

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		const name = url.searchParams.get("name") ?? "world";

		if (url.pathname === "/greet") {
			return new Response(await env.GREET.greet(name));
		}

		if (url.pathname === "/greet-fetch") {
			const greetUrl = new URL("https://greet.internal/");
			greetUrl.searchParams.set("name", name);

			return env.GREET.fetch(new Request(greetUrl));
		}

		return new Response(
			`Try ${url.origin}/greet?name=Ada for RPC or ${url.origin}/greet-fetch?name=Ada for a service fetch.`,
			{ status: 400 },
		);
	},
};
