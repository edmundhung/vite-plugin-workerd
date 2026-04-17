import { describe, expect, it } from "vitest";

const baseUrl = `http://127.0.0.1:${process.env.WORKERD_PORT}`;

describe("bundling", () => {
	it("bundles an npm dependency into the worker", async () => {
		const response = await fetch(`${baseUrl}/?version=v1.2.3&satisfies=^1.0.0`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("1.2.3 satisfies ^1.0.0");
	});

	it("supports dynamically importing a local module", async () => {
		const response = await fetch(`${baseUrl}/lazy?name=Ada`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("Hello from a lazily loaded module, Ada!");
	});

	it("returns helpful validation errors from the bundled dependency path", async () => {
		const invalidVersionResponse = await fetch(`${baseUrl}/?version=not-a-version&satisfies=^1.0.0`);
		expect(invalidVersionResponse.status).toBe(400);
		expect(await invalidVersionResponse.text()).toBe("Invalid version: not-a-version");

		const invalidRangeResponse = await fetch(`${baseUrl}/?version=v1.2.3&satisfies=not-a-range`);
		expect(invalidRangeResponse.status).toBe(400);
		expect(await invalidRangeResponse.text()).toBe("Invalid semver range: not-a-range");
	});
});
