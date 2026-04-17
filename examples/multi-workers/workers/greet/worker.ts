import { WorkerEntrypoint } from "cloudflare:workers";

export default class GreetWorker extends WorkerEntrypoint {
	fetch(request: Request): Response {
		const name = new URL(request.url).searchParams.get("name") ?? "world";

		return new Response(this.greet(name));
	}

	greet(name: string): string {
		return `Hello, ${name}!`;
	}
}
