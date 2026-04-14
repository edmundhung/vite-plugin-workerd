import { describe, expect, it } from "vitest";

const baseUrl = `http://127.0.0.1:${process.env.WORKERD_PORT}`;

describe("hello-world", () => {
	it("returns helpful validation errors", async () => {
		const missingPackageResponse = await fetch(`${baseUrl}/`);
		expect(missingPackageResponse.status).toBe(400);
		expect(await missingPackageResponse.text()).toContain("Missing package name in request path.");

		const missingRangeResponse = await fetch(`${baseUrl}/semver`);
		expect(missingRangeResponse.status).toBe(400);
		expect(await missingRangeResponse.text()).toContain('Missing required "satisfies" query parameter.');

		const invalidRangeResponse = await fetch(`${baseUrl}/semver?satisfies=not-a-range`);
		expect(invalidRangeResponse.status).toBe(400);
		expect(await invalidRangeResponse.text()).toContain(
			"Invalid semver range for semver: not-a-range",
		);
	});

	it("checks latest versions against the requested range", async () => {
		const satisfiedResponse = await fetch(`${baseUrl}/vite-plugin-workerd?satisfies=%3E%3D0.0.0`);
		expect(satisfiedResponse.status).toBe(200);
		expect(await satisfiedResponse.text()).toMatch(/^vite-plugin-workerd@.+ satisfies >=0\.0\.0$/);

		const unsatisfiedResponse = await fetch(`${baseUrl}/vite-plugin-workerd?satisfies=%3C0.0.0`);
		expect(unsatisfiedResponse.status).toBe(200);
		expect(await unsatisfiedResponse.text()).toMatch(
			/^vite-plugin-workerd@.+ does not satisfy <0\.0\.0$/,
		);
	});

	it("surfaces upstream registry failures", async () => {
		const missingPackageResponse = await fetch(
			`${baseUrl}/vite-plugin-workerd-example-package-does-not-exist?satisfies=%5E1.0.0`,
		);
		expect(missingPackageResponse.status).toBe(404);
		expect(await missingPackageResponse.text()).toContain(
			"Registry lookup failed for vite-plugin-workerd-example-package-does-not-exist with 404.",
		);
	});
});
