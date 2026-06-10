import { Hono } from "hono";
import { cors } from "hono/cors";

interface Env {
	AI: Ai;
}

type ResearchRequest = {
	query?: string;
	message?: string;
	urls?: string[];
};

type SourceResult = {
	title: string;
	url: string;
	excerpt: string;
};

const MODEL = "@cf/meta/llama-3.2-3b-instruct";
const MAX_SOURCES = 4;
const MAX_SOURCE_CHARS = 3600;

const app = new Hono<{ Bindings: Env }>();
app.use("*", cors());

app.get("/", (c) =>
	c.json({
		agent: "mcp-research-agent-232347",
		status: "ok",
		capabilities: ["web-source-fetch", "wikipedia-discovery", "source-grounded-summary"],
		endpoints: {
			research: "POST /research { query, urls? }",
			chat: "POST /chat { message }",
		},
	}),
);

app.get("/health", (c) => c.json({ ok: true, agent: "mcp-research-agent-232347" }));

app.post("/chat", async (c) => {
	const body = (await c.req.json<ResearchRequest>().catch(() => ({}))) as ResearchRequest;
	const query = body.message || body.query;
	return runResearch(c.env, { query, urls: body.urls });
});

app.post("/research", async (c) => {
	const body = (await c.req.json<ResearchRequest>().catch(() => ({}))) as ResearchRequest;
	return runResearch(c.env, body);
});

async function runResearch(env: Env, body: ResearchRequest): Promise<Response> {
	const query = (body.query || body.message || "").trim();
	if (!query && (!body.urls || body.urls.length === 0)) {
		return json({ error: "query or urls is required" }, 400);
	}

	const urls = normalizeUrls(body.urls?.length ? body.urls : await discoverWikipedia(query));
	const settled = await Promise.allSettled(urls.slice(0, MAX_SOURCES).map(fetchSource));
	const sources = settled
		.filter((item): item is PromiseFulfilledResult<SourceResult> => item.status === "fulfilled")
		.map((item) => item.value)
		.filter((source) => source.excerpt.length > 120);

	if (sources.length === 0) {
		return json({
			query,
			answer: "I could not fetch enough public source text to produce a grounded answer.",
			sources: [],
		});
	}

	const sourceBlock = sources
		.map((source, index) =>
			"[" + (index + 1) + "] " + source.title + "\nURL: " + source.url + "\nEXCERPT:\n" + sanitizeSourceExcerpt(source.excerpt),
		)
		.join("\n\n---\n\n");

	const prompt = "Research question: " + (query || "Summarize the supplied sources") + "\n\nUse only the source excerpts below. Give a concise answer and key findings. Cite only the source labels I provide, such as [1] or [2]. Do not invent citation numbers. If the sources are insufficient, say what is missing.\n\n" + sourceBlock;
	const aiResult = (await env.AI.run(MODEL, {
		messages: [
			{
				role: "system",
				content:
					"You are a careful research assistant. Stay grounded in provided source excerpts and cite claims with bracketed source numbers.",
			},
			{ role: "user", content: prompt },
		],
	})) as { response?: string; choices?: Array<{ message?: { content?: string } }> };

	return json({
		query,
		answer: normalizeCitations(aiResult.response || aiResult.choices?.[0]?.message?.content || "No answer generated.", sources.length),
		sources: sources.map((source) => ({
			title: source.title,
			url: source.url,
			excerpt: source.excerpt.slice(0, 500),
		})),
	});
}

async function discoverWikipedia(query: string): Promise<string[]> {
	if (!query) return [];
	const url = new URL("https://en.wikipedia.org/w/api.php");
	url.searchParams.set("action", "opensearch");
	url.searchParams.set("search", query);
	url.searchParams.set("limit", String(MAX_SOURCES));
	url.searchParams.set("namespace", "0");
	url.searchParams.set("format", "json");
	const res = await fetch(url.toString(), { headers: { "User-Agent": "ProAgentStoreResearchBot/1.0" } });
	if (!res.ok) return [];
	const data = (await res.json()) as [string, string[], string[], string[]];
	return Array.isArray(data?.[3]) ? data[3] : [];
}

function normalizeUrls(urls: string[] = []): string[] {
	const normalized: string[] = [];
	for (const raw of urls) {
		try {
			const url = new URL(raw);
			if ((url.protocol === "https:" || url.protocol === "http:") && !normalized.includes(url.href)) {
				normalized.push(url.href);
			}
		} catch {
			// Ignore malformed URLs.
		}
	}
	return normalized;
}

async function fetchSource(url: string): Promise<SourceResult> {
	const res = await fetch(url, {
		headers: {
			"User-Agent": "ProAgentStoreResearchBot/1.0",
			Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
		},
	});
	if (!res.ok) throw new Error("Fetch failed " + res.status + ": " + url);
	const contentType = res.headers.get("content-type") || "";
	const raw = await res.text();
	const title = contentType.includes("html") ? extractTitle(raw) || new URL(url).hostname : new URL(url).hostname;
	const text = contentType.includes("json") ? JSON.stringify(JSON.parse(raw)).slice(0, MAX_SOURCE_CHARS) : htmlToText(raw);
	return { title, url, excerpt: text.slice(0, MAX_SOURCE_CHARS) };
}

function extractTitle(html: string): string | null {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? decodeEntities(stripTags(match[1])).trim() : null;
}

function htmlToText(html: string): string {
	return decodeEntities(
		stripTags(
			html
				.replace(/<script[\s\S]*?<\/script>/gi, " ")
				.replace(/<style[\s\S]*?<\/style>/gi, " ")
				.replace(/<nav[\s\S]*?<\/nav>/gi, " ")
				.replace(/<footer[\s\S]*?<\/footer>/gi, " "),
		),
	)
		.replace(/\s+/g, " ")
		.trim();
}

function sanitizeSourceExcerpt(value: string): string {
	return value.replace(/\\[\\d+\\]/g, "").replace(/\\s+/g, " ").trim();
}

function normalizeCitations(answer: string, sourceCount: number): string {
	return answer.replace(/\[(\d+)\]/g, (_match, raw) => {
		const index = Number(raw);
		if (index >= 1 && index <= sourceCount) return "[" + index + "]";
		return sourceCount > 0 ? "[1]" : "";
	});
}

function stripTags(value: string): string {
	return value.replace(/<[^>]+>/g, " ");
}

function decodeEntities(value: string): string {
	return value
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export class AgentDO {
	constructor(private state: DurableObjectState, private env: Env) {}

	async fetch(request: Request): Promise<Response> {
		return app.fetch(request, this.env);
	}
}

export default app;
