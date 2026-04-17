import { WorkerEntrypoint } from "cloudflare:workers";

export default class GreetWorker extends WorkerEntrypoint {
	fetch(): Response {
		return new Response("Hello, world!");
	}

	greet(name: string): string {
		return `Hello, ${name}!`;
	}
}
