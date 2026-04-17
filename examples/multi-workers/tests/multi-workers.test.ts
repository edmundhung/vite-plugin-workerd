import { describe, expect, it } from "vitest";

const baseUrl = `http://127.0.0.1:${process.env.WORKERD_PORT}`;

describe("multi-workers", () => {
	it("routes to the greet worker binding over RPC", async () => {
		const response = await fetch(`${baseUrl}/greet?name=Ada`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("Hello, Ada!");
	});

	it("routes to the greet worker binding over fetch", async () => {
		const response = await fetch(`${baseUrl}/greet-fetch?name=Lin`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("Hello, Lin!");
	});

	it("returns a small usage hint for other paths", async () => {
		const response = await fetch(`${baseUrl}/`);
		const body = await response.text();

		expect(response.status).toBe(400);
		expect(body).toContain("/greet?name=Ada");
		expect(body).toContain("/greet-fetch?name=Ada");
	});
});
