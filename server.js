// ===========================================================================
// TECH STACK: THREE LAYERS WORKING TOGETHER
//   express   			: HTTP server (handles login REST endpoint + serves the webpage)
//   http       		: Node's raw HTTP module, needed so Socket.io can share the port
//   socket.io  		: WEBSOCKET LAYER — real-time bidirectional events over that same port
//   jsonwebtoken (jwt) : SIGNS AND VERIFIES TOKENS so we never store sessions
// ===========================================================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();

// WRAPPING EXPRESS IN A RAW HTTP SERVER LETS SOCKET.IO ATTACH TO IT.
// BOTH HTTP REQUESTS AND WEBSOCKET UPGRADES SHARE PORT 3000.
const server = http.createServer(app);
const io = new Server(server);

// == JWT SECRET ================================================
// THIS STRING IS THE SIGNING KEY FOR EVERY TOKEN WE ISSUE.
// ANYONE WHO KNOWS IT CAN FORGE VALID TOKENS.
// BENEFIT: NO DATABASE NEEDED — THE TOKEN IS SELF-CONTAINED PROOF OF IDENTITY.
// PITFALL: HARDCODING IT IN SOURCE CODE IS A SECURITY RISK IN PRODUCTION.
//          IN THE REAL WORLD: LOAD THIS FROM AN ENVIRONMENT VARIABLE.
const JWT_SECRET = "zerotrust-dev-secret-change-in-prod";
const PORT = 3000;

// == HARDCODED USER STORE =======================================
// BENEFIT: ZERO INFRASTRUCTURE — NO DATABASE, NO ORM, RUNS ANYWHERE.
// PITFALL: PASSWORDS ARE PLAINTEXT IN THE SOURCE CODE.
//          IN PRODUCTION: HASH PASSWORDS WITH bcrypt AND STORE IN A DATABASE.
const USERS = {
	mario: "pass_mario_1!",
	yoshi: "pass_yoshi_2!",
	peach: "pass_peach_3!",
	bowser: "pass_bowser_4!",
};

// === Madlib Templates ==========================================
const MADLIBS = [
	{
		title: "The Heroic Quest",
		story: "Once upon a time, a {adjective} {noun} decided to {verb} across the {adjective2} land of {place}. Armed with a {noun2}, they {verb2} bravely into the {adjective3} unknown.",
		slots: ["adjective", "noun", "verb", "adjective2", "place", "noun2", "verb2", "adjective3"],
	},
	{
		title: "The Tech Startup",
		story: "Our {adjective} startup is disrupting the {noun} industry by using {adjective2} AI to {verb} your {noun2}. We {verb2} synergies at {number}x the speed of our {adjective3} competitors.",
		slots: ["adjective", "noun", "adjective2", "verb", "noun2", "verb2", "number", "adjective3"],
	},
	{
		title: "The Cooking Show",
		story: "Today we're making {adjective} {food} with a {adjective2} {noun} sauce. First, {verb} the {food2} for {number} minutes until it becomes {adjective3} and {adjective4}.",
		slots: ["adjective", "food", "adjective2", "noun", "verb", "food2", "number", "adjective3", "adjective4"],
	},
	{
		title: "Breaking News",
		story: "BREAKING: A {adjective} {noun} was spotted {verb}ing near downtown {place} today. Witnesses described it as '{adjective2} and {adjective3}'. Officials urge citizens to {verb2} immediately.",
		slots: ["adjective", "noun", "verb", "place", "adjective2", "adjective3", "verb2"],
	},
	{
		title: "The Science Paper",
		story: "Abstract: We present a novel {adjective} framework for {verb}ing {noun}s using {adjective2} neural {noun2}s. Our results show {number}% improvement over {adjective3} baselines when applied to {place}.",
		slots: ["adjective", "verb", "noun", "adjective2", "noun2", "number", "adjective3", "place"],
	},
	{
		title: "The Dating Profile",
		story: "Hi! I'm a {adjective} {noun} who loves to {verb} on weekends. My friends say I'm {adjective2} and {adjective3}. Looking for someone who appreciates a good {noun2} and isn't afraid to {verb2}.",
		slots: ["adjective", "noun", "verb", "adjective2", "adjective3", "noun2", "verb2"],
	},
];

// === In-Memory State ==========================================
// ALL CONNECTED USERS LIVE HERE. KEY = SOCKET ID (UNIQUE PER CONNECTION).
// PITFALL: THIS RESETS IF THE SERVER RESTARTS. NO PERSISTENCE.
const connectedUsers = new Map(); // socketId : { username, socketId }

let madlibState = {
	active: false,
	template: null,
	slots: [],
	currentSlotIndex: 0,
	turnOrder: [], // array of socketIds in round-robin order
	turnOrderIndex: 0,
};

function resetMadlib() {
	madlibState = {
		active: false,
		template: null,
		slots: [],
		currentSlotIndex: 0,
		turnOrder: [],
		turnOrderIndex: 0,
	};
}

function getUserList() {
	return Array.from(connectedUsers.values()).map((u) => u.username);
}

function buildTurnOrder() {
	return Array.from(connectedUsers.keys()); // socketIds
}

function currentTurnUser() {
	const socketId = madlibState.turnOrder[madlibState.turnOrderIndex % madlibState.turnOrder.length];
	return connectedUsers.get(socketId);
}

function assembleMadlib() {
	let story = madlibState.template.story;
	madlibState.slots.forEach((slot) => {
		story = story.replace(`{${slot.type}}`, `**${slot.value}**`);
	});
	return story;
}

// ===========================================================================
// LAYER 1: HTTP / REST  (used only for login)
// CLIENT SENDS: POST /login  { username, password }
// SERVER REPLIES: { token, username }  — or 401 if credentials are wrong
// AFTER THIS, THE CLIENT USES THE TOKEN FOR EVERYTHING. NO COOKIES, NO SESSIONS.
// ===========================================================================

// PARSE JSON BODIES SO req.body WORKS IN OUR LOGIN ROUTE.
app.use(express.json());

// SERVE index.html AND ALL STATIC ASSETS FROM THIS FOLDER.
app.use(express.static(path.join(__dirname)));

app.post("/login", (req, res) => {
	const { username, password } = req.body;

	// CREDENTIAL CHECK: COMPARE AGAINST OUR IN-MEMORY USER STORE.
	if (!username || !password || USERS[username] !== password) {
		return res.status(401).json({ error: "Invalid credentials" });
	}

	// JWT SIGNING: WE EMBED THE USERNAME INTO THE TOKEN PAYLOAD.
	// jwt.sign() CREATES THREE BASE64 PARTS: HEADER.PAYLOAD.SIGNATURE
	// THE SIGNATURE IS COMPUTED WITH JWT_SECRET — TAMPERING WITH THE PAYLOAD BREAKS IT.
	// expiresIn: "2h" : THE TOKEN SELF-DESTRUCTS AFTER 2 HOURS. NO REVOCATION NEEDED.
	const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "2h" });

	// WE SEND THE TOKEN BACK. THE CLIENT STORES IT IN MEMORY AND ATTACHES IT TO EVERY REQUEST.
	// BENEFIT: STATELESS — THE SERVER DOESN'T REMEMBER WHO IS LOGGED IN.
	// PITFALL: IF A TOKEN IS STOLEN, THE ATTACKER HAS FULL ACCESS UNTIL IT EXPIRES.
	res.json({ token, username });
});

// ===========================================================================
// LAYER 2: WEBSOCKETS (used for all real-time chat and game events)
// HTTP IS REQUEST/RESPONSE — CLIENT ASKS, SERVER ANSWERS, CONNECTION CLOSES.
// WEBSOCKETS STAY OPEN: EITHER SIDE CAN SEND DATA AT ANY TIME.
// Socket.io WRAPS WEBSOCKETS AND ADDS: EVENTS, ROOMS, AUTO-RECONNECT, FALLBACKS.
// ===========================================================================

// == ZERO-TRUST CONNECTION GATE ====================================
// THIS MIDDLEWARE RUNS BEFORE ANY SOCKET IS ALLOWED TO CONNECT.
// THE CLIENT PASSES ITS JWT IN THE HANDSHAKE (socket.handshake.auth.token).
// WE VERIFY IT HERE — IF IT'S MISSING, FORGED, OR EXPIRED: CONNECTION REFUSED.
// BENEFIT: THE WEBSOCKET CHANNEL IS AS SECURE AS THE TOKEN.
// PITFALL: THE HANDSHAKE ONLY RUNS ONCE AT CONNECT TIME.
//          A TOKEN COULD EXPIRE MID-SESSION WITHOUT THIS CHECK CATCHING IT...
//          ...WHICH IS WHY WE RE-VERIFY ON EVERY MESSAGE BELOW.
io.use((socket, next) => {
	const token = socket.handshake.auth?.token;
	if (!token) return next(new Error("No token — connection refused"));
	try {
		// jwt.verify() DECODES THE TOKEN AND CHECKS THE SIGNATURE + EXPIRY.
		// IF EITHER FAILS IT THROWS — WE CATCH AND REJECT THE CONNECTION.
		const payload = jwt.verify(token, JWT_SECRET);
		socket.username = payload.username; // ATTACH USERNAME TO THIS SOCKET OBJECT
		next(); // ALLOW THE CONNECTION
	} catch {
		next(new Error("Invalid or expired token — connection refused"));
	}
});

// === Socket.io: Events ==========================================
io.on("connection", (socket) => {
	console.log(`[+] ${socket.username} connected (${socket.id})`);

	// REGISTER THIS USER IN OUR IN-MEMORY MAP.
	// socket.id IS A UNIQUE STRING ASSIGNED BY Socket.io FOR THIS CONNECTION.
	connectedUsers.set(socket.id, { username: socket.username, socketId: socket.id });

	// io.emit() = BROADCAST TO ALL CONNECTED SOCKETS (INCLUDING THE SENDER).
	// socket.emit() = SEND ONLY TO THIS ONE SOCKET.
	io.emit("chat:message", {
		system: true,
		text: `${socket.username} joined the room.`,
		users: getUserList(),
	});

	socket.emit("users:update", getUserList());

	// == Chat Message ==
	socket.on("chat:send", (data) => {
		// ZERO-TRUST PRINCIPLE: "NEVER TRUST, ALWAYS VERIFY."
		// EVEN THOUGH WE CHECKED THE TOKEN AT CONNECT TIME, WE CHECK AGAIN HERE.
		// WHY? THE TOKEN MAY HAVE EXPIRED WHILE THE SOCKET WAS STILL CONNECTED.
		// THIS ENSURES AN EXPIRED SESSION CANNOT KEEP SENDING MESSAGES.
		const token = socket.handshake.auth?.token;
		try {
			jwt.verify(token, JWT_SECRET);
		} catch {
			// TOKEN EXPIRED MID-SESSION: KICK THE USER AND TELL THEM TO RE-LOGIN.
			socket.emit("error:auth", "Token expired. Please log in again.");
			socket.disconnect();
			return;
		}

		const text = (data?.text || "").trim();
		if (!text) return;

		// Check for madlib trigger
		if (text.toLowerCase() === "new") {
			if (madlibState.active) {
				socket.emit("chat:message", { system: true, text: "A Madlib is already in progress!" });
				return;
			}
			startMadlib();
			return;
		}

		// If it's this user's madlib turn, treat message as their word submission
		if (madlibState.active) {
			const turn = currentTurnUser();
			if (turn && turn.socketId === socket.id) {
				submitMadlibWord(text, socket);
				return;
			} else {
				// Regular chat is still allowed while others wait
				io.emit("chat:message", { username: socket.username, text });
				return;
			}
		}

		io.emit("chat:message", { username: socket.username, text });
	});

	// == Disconnect ==
	socket.on("disconnect", () => {
		console.log(`[-] ${socket.username} disconnected`);

		// CLEAN UP: REMOVE FROM OUR IN-MEMORY MAP SO THEY DON'T APPEAR ONLINE.
		connectedUsers.delete(socket.id);

		// If they were in the middle of a madlib turn, skip them
		if (madlibState.active) {
			madlibState.turnOrder = madlibState.turnOrder.filter((id) => id !== socket.id);
			if (madlibState.turnOrder.length === 0) {
				resetMadlib();
				io.emit("chat:message", { system: true, text: "Madlib cancelled — not enough players." });
			} else {
				broadcastMadlibTurn();
			}
		}

		io.emit("chat:message", {
			system: true,
			text: `${socket.username} left the room.`,
			users: getUserList(),
		});
		io.emit("users:update", getUserList());
	});
});

// === Madlib Logic =============================================
function startMadlib() {
	const template = MADLIBS[Math.floor(Math.random() * MADLIBS.length)];
	madlibState = {
		active: true,
		template,
		slots: template.slots.map((type) => ({ type, value: null })),
		currentSlotIndex: 0,
		turnOrder: buildTurnOrder(),
		turnOrderIndex: 0,
	};

	io.emit("madlib:start", {
		title: template.title,
		slots: template.slots,
		story: template.story,
	});

	io.emit("chat:message", {
		system: true,
		text: `🎲 New Madlib started: "${template.title}"! Fill in the blanks one by one.`,
	});

	broadcastMadlibTurn();
}

function broadcastMadlibTurn() {
	const slot = madlibState.slots[madlibState.currentSlotIndex];
	const user = currentTurnUser();
	if (!user) return;

	io.emit("madlib:turn", {
		slotIndex: madlibState.currentSlotIndex,
		slotType: slot.type,
		username: user.username,
		socketId: user.socketId,
	});

	io.emit("chat:message", {
		system: true,
		text: `👉 ${user.username}'s turn — type a ${slot.type.toUpperCase()}`,
	});
}

function submitMadlibWord(word, socket) {
	const slot = madlibState.slots[madlibState.currentSlotIndex];
	slot.value = word;

	io.emit("madlib:wordFilled", {
		slotIndex: madlibState.currentSlotIndex,
		slotType: slot.type,
		value: word,
		username: socket.username,
	});

	io.emit("chat:message", {
		system: true,
		text: `✅ ${socket.username} submitted "${word}" for ${slot.type}`,
	});

	madlibState.currentSlotIndex++;
	madlibState.turnOrderIndex++;

	if (madlibState.currentSlotIndex >= madlibState.slots.length) {
		// All filled — reveal!
		const completed = assembleMadlib();
		io.emit("madlib:reveal", {
			title: madlibState.template.title,
			story: completed,
		});
		io.emit("chat:message", { system: true, text: `🎉 Madlib complete! Read the result above.` });
		resetMadlib();
	} else {
		broadcastMadlibTurn();
	}
}

// === Start ===================================================
// ONE PORT, TWO PROTOCOLS: HTTP AND WEBSOCKET BOTH LISTEN HERE.
// HTTP HANDLES THE INITIAL PAGE LOAD AND LOGIN.
// WEBSOCKET TAKES OVER FOR EVERYTHING AFTER THAT.
server.listen(PORT, () => {
	console.log(`Zero-Trust Chat running at http://localhost:${PORT}`);
	console.log(`Users: ${Object.keys(USERS).join(", ")}`);
});
