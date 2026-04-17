import { clean, satisfies, validRange } from "semver";

export default {
	async fetch(request: Request) {
		const url = new URL(request.url);

		if (url.pathname === "/lazy") {
			const name = url.searchParams.get("name") ?? "world";
			const { renderLazyGreeting } = await import("./lazy");

			return new Response(renderLazyGreeting(name));
		}

		const versionInput = url.searchParams.get("version") ?? "v1.2.3";
		const range = url.searchParams.get("satisfies") ?? "^1.0.0";
		const version = clean(versionInput);

		if (!version) {
			return new Response(`Invalid version: ${versionInput}`, { status: 400 });
		}

		if (!validRange(range)) {
			return new Response(`Invalid semver range: ${range}`, { status: 400 });
		}

		return new Response(
			`${version} ${satisfies(version, range) ? "satisfies" : "does not satisfy"} ${range}`,
		);
	},
};
