import { describe, expect, it } from "vitest";

const baseUrl = `http://127.0.0.1:${process.env.WORKERD_PORT}`;

describe("hello-world", () => {
	it("returns a hello world response", async () => {
		const response = await fetch(`${baseUrl}/`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("Hello, world!");
	});
});
