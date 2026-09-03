// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// Current conversation
let chatHistory = [];
let isProcessing = false;

// Start app
loadHistory();

// Auto-resize textbox
userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = this.scrollHeight + "px";
});

// Press Enter to send
userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

sendButton.addEventListener("click", sendMessage);

// Load saved messages from Cloudflare D1
async function loadHistory() {
	try {
		const response = await fetch("/api/history");

		if (!response.ok) {
			throw new Error("Could not load chat history");
		}

		const savedMessages = await response.json();

		// Remove the template greeting already in the HTML
		chatMessages.innerHTML = "";

		if (Array.isArray(savedMessages) && savedMessages.length > 0) {
			chatHistory = savedMessages
				.filter(
					(message) =>
						message.role === "user" ||
						message.role === "assistant",
				)
				.map((message) => ({
					role: message.role,
					content: message.content,
				}));

			for (const message of chatHistory) {
				addMessageToChat(message.role, message.content);
			}
		} else {
			showWelcomeMessage();
		}
	} catch (error) {
		console.error("History load error:", error);

		chatMessages.innerHTML = "";
		showWelcomeMessage();
	}
}

function showWelcomeMessage() {
	addMessageToChat(
		"assistant",
		"Hello! I'm your personal AI assistant powered by gpt-oss-120b. How can I help you?",
	);
}

// Send message
async function sendMessage() {
	const message = userInput.value.trim();

	if (!message || isProcessing) return;

	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;

	addMessageToChat("user", message);

	userInput.value = "";
	userInput.style.height = "auto";

	typingIndicator.classList.add("visible");

	chatHistory.push({
		role: "user",
		content: message,
	});

	try {
		const assistantMessageEl = document.createElement("div");
		assistantMessageEl.className =
			"message assistant-message";

		const assistantTextEl = document.createElement("p");
		assistantMessageEl.appendChild(assistantTextEl);

		chatMessages.appendChild(assistantMessageEl);
		chatMessages.scrollTop = chatMessages.scrollHeight;

		const response = await fetch("/api/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				// Keep recent conversation context manageable
				messages: chatHistory.slice(-40),
			}),
		});

		if (!response.ok) {
			throw new Error("Failed to get AI response");
		}

		if (!response.body) {
			throw new Error("Response stream unavailable");
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();

		let responseText = "";
		let buffer = "";
		let finished = false;

		while (!finished) {
			const { done, value } = await reader.read();

			if (done) {
				buffer += "\n\n";
				processBuffer();
				break;
			}

			buffer += decoder.decode(value, {
				stream: true,
			});

			processBuffer();
		}

		function processBuffer() {
			buffer = buffer.replace(/\r/g, "");

			let eventEnd;

			while (
				(eventEnd = buffer.indexOf("\n\n")) !== -1
			) {
				const rawEvent = buffer.slice(0, eventEnd);
				buffer = buffer.slice(eventEnd + 2);

				const data = rawEvent
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) =>
						line.slice(5).trimStart(),
					)
					.join("\n");

				if (!data) continue;

				if (data === "[DONE]") {
					finished = true;
					continue;
				}

				try {
					const parsed = JSON.parse(data);

					let content = "";

					if (
						typeof parsed.response === "string"
					) {
						content = parsed.response;
					} else if (
						parsed.choices?.[0]?.delta?.content
					) {
						content =
							parsed.choices[0].delta.content;
					}

					if (content) {
						responseText += content;
						assistantTextEl.textContent =
							responseText;

						chatMessages.scrollTop =
							chatMessages.scrollHeight;
					}
				} catch (error) {
					console.error(
						"Streaming parse error:",
						error,
					);
				}
			}
		}

		if (responseText.trim()) {
			chatHistory.push({
				role: "assistant",
				content: responseText,
			});
		}
	} catch (error) {
		console.error("Chat error:", error);

		addMessageToChat(
			"assistant",
			"Sorry, something went wrong.",
		);
	} finally {
		typingIndicator.classList.remove("visible");

		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		userInput.focus();
	}
}

// Display message safely
function addMessageToChat(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;

	const textEl = document.createElement("p");
	textEl.textContent = content;

	messageEl.appendChild(textEl);
	chatMessages.appendChild(messageEl);

	chatMessages.scrollTop = chatMessages.scrollHeight;
}
