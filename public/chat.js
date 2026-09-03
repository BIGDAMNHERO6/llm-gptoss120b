const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const conversationList = document.getElementById("conversation-list");
const newChatButton = document.getElementById("new-chat-button");
const chatTitle = document.getElementById("chat-title");
const sidebar = document.getElementById("sidebar");
const mobileSidebarButton = document.getElementById("mobile-sidebar-button");

let currentConversationId = null;
let conversations = [];
let isProcessing = false;


// START APP
initializeApp();


// TEXT BOX
userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = Math.min(this.scrollHeight, 180) + "px";
});

userInput.addEventListener("keydown", function (event) {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		sendMessage();
	}
});

sendButton.addEventListener("click", sendMessage);


// NEW CHAT
newChatButton.addEventListener("click", async () => {
	if (isProcessing) return;

	await createNewConversation();

	if (window.innerWidth <= 700) {
		sidebar.classList.remove("open");
	}
});


// MOBILE SIDEBAR
mobileSidebarButton.addEventListener("click", () => {
	sidebar.classList.toggle("open");
});


// INITIALIZE
async function initializeApp() {
	try {
		await loadConversations();

		if (conversations.length === 0) {
			await createNewConversation();
			return;
		}

		const rememberedId = localStorage.getItem("activeConversationId");

		const rememberedConversation = conversations.find(
			(conversation) => conversation.id === rememberedId
		);

		if (rememberedConversation) {
			await openConversation(rememberedConversation.id);
		} else {
			await openConversation(conversations[0].id);
		}
	} catch (error) {
		console.error("Initialization error:", error);
		showEmptyChat();
	}
}


// LOAD SIDEBAR
async function loadConversations() {
	const response = await fetch("/api/conversations");

	if (!response.ok) {
		throw new Error("Could not load conversations");
	}

	const result = await response.json();

	conversations = Array.isArray(result) ? result : [];

	renderConversationList();
}


// RENDER SIDEBAR
function renderConversationList() {
	conversationList.innerHTML = "";

	for (const conversation of conversations) {
		const item = document.createElement("div");

		item.className = "conversation-item";

		if (conversation.id === currentConversationId) {
			item.classList.add("active");
		}

		item.textContent = conversation.title || "New Chat";
		item.title = conversation.title || "New Chat";

		item.addEventListener("click", async () => {
			if (isProcessing) return;

			await openConversation(conversation.id);

			if (window.innerWidth <= 700) {
				sidebar.classList.remove("open");
			}
		});

		conversationList.appendChild(item);
	}
}


// CREATE NEW CHAT
async function createNewConversation() {
	try {
		const response = await fetch("/api/conversations", {
			method: "POST",
		});

		if (!response.ok) {
			throw new Error("Could not create conversation");
		}

		const conversation = await response.json();

		currentConversationId = conversation.id;

		localStorage.setItem(
			"activeConversationId",
			currentConversationId
		);

		await loadConversations();
		await openConversation(currentConversationId);

		userInput.focus();
	} catch (error) {
		console.error("New conversation error:", error);
	}
}


// OPEN CHAT
async function openConversation(conversationId) {
	currentConversationId = conversationId;

	localStorage.setItem(
		"activeConversationId",
		currentConversationId
	);

	const conversation = conversations.find(
		(item) => item.id === conversationId
	);

	chatTitle.textContent = conversation?.title || "New Chat";

	renderConversationList();

	chatMessages.innerHTML = "";

	try {
		const response = await fetch(
			`/api/conversations/${encodeURIComponent(conversationId)}/messages`
		);

		if (!response.ok) {
			throw new Error("Could not load messages");
		}

		const messages = await response.json();

		if (Array.isArray(messages) && messages.length > 0) {
			for (const message of messages) {
				addMessageToChat(
					message.role,
					message.content
				);
			}
		} else {
			showEmptyChat();
		}
	} catch (error) {
		console.error("Message loading error:", error);
		showEmptyChat();
	}

	userInput.focus();
}


// EMPTY CHAT
function showEmptyChat() {
	chatMessages.innerHTML = "";

	addMessageToChat(
		"assistant",
		"Hello! I'm your personal AI assistant powered by gpt-oss-120b. How can I help you?"
	);
}


// SEND MESSAGE
async function sendMessage() {
	const message = userInput.value.trim();

	if (!message || isProcessing) return;

	if (!currentConversationId) {
		await createNewConversation();
	}

	isProcessing = true;

	userInput.disabled = true;
	sendButton.disabled = true;
	newChatButton.disabled = true;

	addMessageToChat("user", message);

	userInput.value = "";
	userInput.style.height = "auto";

	typingIndicator.classList.add("visible");

	try {
		const assistantMessage = document.createElement("div");
		assistantMessage.className = "message assistant-message";

		const assistantText = document.createElement("p");

		assistantMessage.appendChild(assistantText);
		chatMessages.appendChild(assistantMessage);

		scrollToBottom();

		const response = await fetch(
			`/api/conversations/${encodeURIComponent(currentConversationId)}/chat`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					message: message,
				}),
			}
		);

		if (!response.ok) {
			throw new Error("AI request failed");
		}

		if (!response.body) {
			throw new Error("No response stream");
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();

		let buffer = "";
		let responseText = "";
		let finished = false;

		while (!finished) {
			const { done, value } = await reader.read();

			if (done) {
				buffer += decoder.decode();
				buffer += "\n\n";
				processStreamBuffer();
				break;
			}

			buffer += decoder.decode(value, {
				stream: true,
			});

			processStreamBuffer();
		}

		function processStreamBuffer() {
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
						line.slice(5).trimStart()
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
						assistantText.textContent =
							responseText;

						scrollToBottom();
					}
				} catch (error) {
					console.error(
						"Stream parsing error:",
						error
					);
				}
			}
		}

		if (!responseText.trim()) {
			assistantMessage.remove();

			addMessageToChat(
				"assistant",
				"I didn't receive a response. Please try again."
			);
		}

		// Reload sidebar so the new automatic chat title appears
		await loadConversations();

		const activeConversation = conversations.find(
			(item) =>
				item.id === currentConversationId
		);

		if (activeConversation) {
			chatTitle.textContent =
				activeConversation.title;
		}

		renderConversationList();

	} catch (error) {
		console.error("Chat error:", error);

		addMessageToChat(
			"assistant",
			"Sorry, something went wrong. Please try again."
		);
	} finally {
		typingIndicator.classList.remove("visible");

		isProcessing = false;

		userInput.disabled = false;
		sendButton.disabled = false;
		newChatButton.disabled = false;

		userInput.focus();
	}
}


// DISPLAY MESSAGE
function addMessageToChat(role, content) {
	const message = document.createElement("div");

	message.className =
		`message ${role}-message`;

	const text = document.createElement("p");

	text.textContent = content;

	message.appendChild(text);
	chatMessages.appendChild(message);

	scrollToBottom();
}


// SCROLL
function scrollToBottom() {
	chatMessages.scrollTop =
		chatMessages.scrollHeight;
}
