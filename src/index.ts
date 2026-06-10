import { Hono } from "hono";

interface Env {
	AI: Ai;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ agent: "mcp-research-agent-232347", status: "ok" }));

app.post("/chat", async (c) => {
	const { message } = await c.req.json<{ message: string }>();
	const result = await c.env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
		messages: [
			{ role: "system", content: "You are MCP Research Agent. Researches a topic from public web sources, summarizes findings, and returns citations." },
			{ role: "user", content: message },
		],
	});
	return c.json(result);
});

export class AgentDO {
	constructor(private state: DurableObjectState, private env: Env) {}

	async fetch(request: Request): Promise<Response> {
		return app.fetch(request, this.env);
	}
}

export default app;
