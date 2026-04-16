import { satisfies, validRange } from "semver";

export default {
	async fetch(request: Request, env: { GREET: any }) {
		const url = new URL(request.url);
		const packageName = decodeURIComponent(url.pathname.slice(1));
		const range = url.searchParams.get("satisfies");

		if (packageName === "greet") {
			return env.GREET.fetch(request);
		}

		if (!packageName) {
			return new Response(
				`Missing package name in request path. Example: ${url.origin}/vite-plugin-workerd?satisfies=^1.0.0`,
				{ status: 400 },
			);
		}

		if (!range) {
			return new Response(
				`Missing required "satisfies" query parameter. e.g. ${url.origin}/${packageName}?satisfies=^1.0.0`,
				{ status: 400 },
			);
		}

		if (!validRange(range)) {
			return new Response(`Invalid semver range for ${packageName}: ${range}`, { status: 400 });
		}

		const registryResponse = await fetch(
			`https://registry.npmjs.org/${packageName}/latest`,
			{
				headers: {
					accept: "application/json",
				},
			},
		);

		if (!registryResponse.ok) {
			return new Response(
				`Registry lookup failed for ${packageName} with ${registryResponse.status}.`,
				{ status: registryResponse.status },
			);
		}

		const latest = (await registryResponse.json()) as { version?: unknown };

		if (typeof latest.version !== "string") {
			return new Response(`Registry response did not include a version for ${packageName}.`, {
				status: 502,
			});
		}

		return new Response(
			`${packageName}@${latest.version} ${satisfies(latest.version, range) ? "satisfies" : "does not satisfy"} ${range}`,
		);
	},
};
