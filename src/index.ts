import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/openai/gpt-oss-120b";

const SYSTEM_PROMPT =
	"You are a personal AI assistant powered by OpenAI gpt-oss-120b running on Cloudflare Workers AI. Be concise, accurate, and helpful.";

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Serve the website
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// Load saved chat history
		if (url.pathname === "/api/history" && request.method === "GET") {
			try {
				const result = await env.DB.prepare(
					`SELECT role, content, created_at
					 FROM chats
					 ORDER BY id ASC
					 LIMIT 500`,
				).all();

				return Response.json(result.results);
			} catch (error) {
				console.error("Failed to load history:", error);
				return Response.json([], { status: 500 });
			}
		}

		// Chat endpoint
		if (url.pathname === "/api/chat" && request.method === "POST") {
			return handleChatRequest(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function handleChatRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	try {
		const body = (await request.json()) as {
			messages?: ChatMessage[];
		};

		const messages = body.messages ?? [];

		// Save the newest user message
		const lastUserMessage = [...messages]
			.reverse()
			.find((message) => message.role === "user");

		if (lastUserMessage) {
			await env.DB.prepare(
				"INSERT INTO chats (role, content) VALUES (?, ?)",
			)
				.bind("user", lastUserMessage.content)
				.run();
		}

		// Send a copy to the model
		const modelMessages: ChatMessage[] = [...messages];

		if (!modelMessages.some((message) => message.role === "system")) {
			modelMessages.unshift({
				role: "system",
				content: SYSTEM_PROMPT,
			});
		}

		const inputs = {
			messages: modelMessages,
			max_tokens: 1024,
			stream: true,
		} satisfies AiTextGenerationInput & { stream: true };

		const aiStream = await env.AI.run<typeof MODEL_ID>(
			MODEL_ID,
			inputs,
		);

		// Split the stream:
		// one copy goes to your browser,
		// the other is saved into D1.
		const [browserStream, databaseStream] = aiStream.tee();

		ctx.waitUntil(saveAssistantResponse(databaseStream, env.DB));

		return new Response(browserStream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Chat error:", error);

		return Response.json(
			{ error: "Failed to process request" },
			{ status: 500 },
		);
	}
}

async function saveAssistantResponse(
	stream: ReadableStream,
	db: D1Database,
): Promise<void> {
	try {
		const reader = stream.getReader();
		const decoder = new TextDecoder();

		let buffer = "";
		let fullResponse = "";

		const processEvents = () => {
			buffer = buffer.replace(/\r/g, "");

			let eventEnd;

			while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
				const rawEvent = buffer.slice(0, eventEnd);
				buffer = buffer.slice(eventEnd + 2);

				const data = rawEvent
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");

				if (!data || data === "[DONE]") continue;

				try {
					const parsed = JSON.parse(data);

					if (typeof parsed.response === "string") {
						fullResponse += parsed.response;
					} else if (parsed.choices?.[0]?.delta?.content) {
						fullResponse += parsed.choices[0].delta.content;
					}
				} catch {
					// Ignore incomplete/non-JSON SSE events
				}
			}
		};

		while (true) {
			const { done, value } = await reader.read();

			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			processEvents();
		}

		buffer += decoder.decode();
		buffer += "\n\n";
		processEvents();

		if (fullResponse.trim()) {
			await db
				.prepare("INSERT INTO chats (role, content) VALUES (?, ?)")
				.bind("assistant", fullResponse)
				.run();
		}
	} catch (error) {
		console.error("Failed to save assistant response:", error);
	}
}
