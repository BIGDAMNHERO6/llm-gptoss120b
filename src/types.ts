/**
 * Type definitions for the LLM chat application.
 */

export interface Env {
	AI: Ai;

	ASSETS: {
		fetch: (request: Request) => Promise<Response>;
	};

	DB: D1Database;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}
