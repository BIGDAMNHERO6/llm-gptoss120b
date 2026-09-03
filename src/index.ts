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

		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// OLD chat history - kept temporarily so nothing breaks
		if (url.pathname === "/api/history" && request.method === "GET") {
			const result = await env.DB.prepare(
				`SELECT role, content, created_at
				 FROM chats
				 ORDER BY id ASC
				 LIMIT 500`,
			).all();

			return Response.json(result.results);
		}

		// Get all conversations
		if (
			url.pathname === "/api/conversations" &&
			request.method === "GET"
		) {
			const result = await env.DB.prepare(
				`SELECT id, title, created_at, updated_at
				 FROM conversations
				 ORDER BY updated_at DESC`,
			).all();

			return Response.json(result.results);
		}

		// Create a new conversation
		if (
			url.pathname === "/api/conversations" &&
			request.method === "POST"
		) {
			const id = crypto.randomUUID();

			await env.DB.prepare(
				`INSERT INTO conversations (id, title)
				 VALUES (?, ?)`,
			)
				.bind(id, "New Chat")
				.run();

			return Response.json({
				id,
				title: "New Chat",
			});
		}

		// Routes for one specific conversation
		const match = url.pathname.match(
			/^\/api\/conversations\/([^/]+)\/(messages|chat)$/,
		);

		if (match) {
			const conversationId = match[1];
			const action = match[2];

			if (action === "messages" && request.method === "GET") {
				const result = await env.DB.prepare(
					`SELECT role, content, created_at
					 FROM messages
					 WHERE conversation_id = ?
					 ORDER BY id ASC`,
				)
					.bind(conversationId)
					.all();

				return Response.json(result.results);
			}

			if (action === "chat" && request.method === "POST") {
				return handleConversationChat(
					request,
					env,
					ctx,
					conversationId,
				);
			}
		}

		// OLD chat endpoint - kept temporarily
		if (url.pathname === "/api/chat" && request.method === "POST") {
			return handleOldChat(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function handleConversationChat(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	conversationId: string,
): Promise<Response> {
	try {
		const body = (await request.json()) as {
			message?: string;
		};

		const userMessage = body.message?.trim();

		if (!userMessage) {
			return Response.json(
				{ error: "Message is required" },
				{ status: 400 },
			);
		}

		// Make sure conversation exists
		const conversation = await env.DB.prepare(
			"SELECT id, title FROM conversations WHERE id = ?",
		)
			.bind(conversationId)
			.first<{ id: string; title: string }>();

		if (!conversation) {
			return Response.json(
				{ error: "Conversation not found" },
				{ status: 404 },
			);
		}

		// Save user message
		await env.DB.prepare(
			`INSERT INTO messages
			 (conversation_id, role, content)
			 VALUES (?, ?, ?)`,
		)
			.bind(conversationId, "user", userMessage)
			.run();

		// Automatically name a new chat from the first message
		if (conversation.title === "New Chat") {
			const title =
				userMessage.length > 45
					? userMessage.slice(0, 45) + "..."
					: userMessage;

			await env.DB.prepare(
				`UPDATE conversations
				 SET title = ?, updated_at = CURRENT_TIMESTAMP
				 WHERE id = ?`,
			)
				.bind(title, conversationId)
				.run();
		} else {
			await env.DB.prepare(
				`UPDATE conversations
				 SET updated_at = CURRENT_TIMESTAMP
				 WHERE id = ?`,
			)
				.bind(conversationId)
				.run();
		}

		// Load recent context
		const history = await env.DB.prepare(
			`SELECT role, content
			 FROM (
				SELECT id, role, content
				FROM messages
				WHERE conversation_id = ?
				ORDER BY id DESC
				LIMIT 40
			 )
			 ORDER BY id ASC`,
		)
			.bind(conversationId)
			.all<ChatMessage>();

		const modelMessages: ChatMessage[] = [
			{
				role: "system",
				content: SYSTEM_PROMPT,
			},
			...(history.results as ChatMessage[]),
		];

		const aiStream = await env.AI.run<typeof MODEL_ID>(
			MODEL_ID,
			{
				messages: modelMessages,
				max_tokens: 1024,
				stream: true,
			},
		);

		const [browserStream, databaseStream] = aiStream.tee();

		ctx.waitUntil(
			saveAssistantResponse(
				databaseStream,
				env.DB,
				conversationId,
			),
		);

		return new Response(browserStream, {
			headers: {
				"content-type":
					"text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error(error);

		return Response.json(
			{ error: "Failed to process request" },
			{ status: 500 },
		);
	}
}

// Temporary old chat system
async function handleOldChat(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const body = (await request.json()) as {
		messages?: ChatMessage[];
	};

	const messages = body.messages ?? [];

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

	const modelMessages = [...messages];

	modelMessages.unshift({
		role: "system",
		content: SYSTEM_PROMPT,
	});

	const aiStream = await env.AI.run<typeof MODEL_ID>(
		MODEL_ID,
		{
			messages: modelMessages,
			max_tokens: 1024,
			stream: true,
		},
	);

	const [browserStream, databaseStream] = aiStream.tee();

	ctx.waitUntil(saveOldResponse(databaseStream, env.DB));

	return new Response(browserStream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}

async function readAIStream(stream: ReadableStream): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();

	let buffer = "";
	let fullResponse = "";

	const processEvents = () => {
		buffer = buffer.replace(/\r/g, "");

		let end;

		while ((end = buffer.indexOf("\n\n")) !== -1) {
			const event = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);

			const data = event
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");

			if (!data || data === "[DONE]") continue;

			try {
				const parsed = JSON.parse(data);

				if (typeof parsed.response === "string") {
					fullResponse += parsed.response;
				} else if (
					parsed.choices?.[0]?.delta?.content
				) {
					fullResponse +=
						parsed.choices[0].delta.content;
				}
			} catch {}
		}
	};

	while (true) {
		const { done, value } = await reader.read();

		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		processEvents();
	}

	buffer += "\n\n";
	processEvents();

	return fullResponse;
}

async function saveAssistantResponse(
	stream: ReadableStream,
	db: D1Database,
	conversationId: string,
) {
	const response = await readAIStream(stream);

	if (!response.trim()) return;

	await db
		.prepare(
			`INSERT INTO messages
			 (conversation_id, role, content)
			 VALUES (?, ?, ?)`,
		)
		.bind(conversationId, "assistant", response)
		.run();
}

async function saveOldResponse(
	stream: ReadableStream,
	db: D1Database,
) {
	const response = await readAIStream(stream);

	if (!response.trim()) return;

	await db
		.prepare(
			"INSERT INTO chats (role, content) VALUES (?, ?)",
		)
		.bind("assistant", response)
		.run();
}
