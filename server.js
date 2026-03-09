const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // In production, replace with your Vercel URL
    methods: ["GET", "POST"]
  }
});

// ── Store all active rooms in memory ──────────────────────────────────────────
// rooms[roomCode] = {
//   host: socketId,
//   players: { socketId: { name, color, emoji } },
//   question: { type, text, starterCode, language },
//   timeLimit: 120,
//   winCondition: "first" | "judge" | "time",
//   submissions: { playerName: { answer, timeLeft, timestamp } },
//   started: bool,
//   finished: bool,
//   timerInterval: interval ref
// }
const rooms = {};

const COLORS = ["#ff3366","#00ff88","#ffd700","#00ccff","#ff8800","#cc00ff"];
const EMOJIS = ["🦊","🐺","🦁","🐯","🦅","🐉"];

function getPlayerIndex(room) {
  return Object.keys(room.players).length;
}

function getRoomPlayers(room) {
  return Object.values(room.players);
}

function broadcastLobby(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit("lobby-update", {
    players: getRoomPlayers(room),
    roomCode
  });
}

function startRoomTimer(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  let timeLeft = room.timeLimit;

  room.timerInterval = setInterval(() => {
    timeLeft--;
    io.to(roomCode).emit("timer-tick", { timeLeft, timeLimit: room.timeLimit });

    if (timeLeft <= 0) {
      clearInterval(room.timerInterval);
      handleTimeUp(roomCode);
    }
  }, 1000);
}

function handleTimeUp(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.finished) return;
  room.finished = true;

  if (room.winCondition === "judge") {
    // Tell host to open judge panel
    io.to(room.host).emit("open-judge-panel", {
      submissions: room.submissions
    });
    io.to(roomCode).emit("time-up", { message: "Time's up! Waiting for judge..." });
  } else {
    // Pick whoever submitted with the most time left
    const subs = Object.entries(room.submissions);
    if (subs.length === 0) {
      io.to(roomCode).emit("game-over", { winner: null, message: "Nobody submitted!", results: [] });
    } else {
      const winner = subs.sort((a, b) => b[1].timeLeft - a[1].timeLeft)[0][0];
      endGame(roomCode, winner);
    }
  }
}

function endGame(roomCode, winnerName) {
  const room = rooms[roomCode];
  if (!room) return;
  room.finished = true;
  if (room.timerInterval) clearInterval(room.timerInterval);

  const players = getRoomPlayers(room);
  const results = players
    .map(p => ({
      ...p,
      submission: room.submissions[p.name] || null
    }))
    .sort((a, b) => {
      if (a.name === winnerName) return -1;
      if (b.name === winnerName) return 1;
      if (a.submission && b.submission) return b.submission.timeLeft - a.submission.timeLeft;
      if (a.submission) return -1;
      if (b.submission) return 1;
      return 0;
    });

  io.to(roomCode).emit("game-over", { winner: winnerName, results });
}

function genRoomCode() {
  const words = ["RACE","CODE","HACK","LOOP","FUNC","BYTE","DATA","NULL"];
  const word = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return word + "-" + num;
}

// ── Socket events ──────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // ── HOST creates a room ────────────────────────────────────────────────────
  socket.on("create-room", ({ question, timeLimit, winCondition }) => {
    // Generate a unique room code on the server
    let roomCode;
    do { roomCode = genRoomCode(); } while (rooms[roomCode]);

    rooms[roomCode] = {
      host: socket.id,
      players: {},
      question,
      timeLimit: timeLimit || 120,
      winCondition: winCondition || "first",
      submissions: {},
      started: false,
      finished: false,
      timerInterval: null
    };

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = true;

    console.log(`Room created: ${roomCode}`);
    socket.emit("room-created", { roomCode });
  });

  // ── PLAYER joins a room ────────────────────────────────────────────────────
  socket.on("join-room", ({ roomCode, playerName }) => {
    const room = rooms[roomCode];

    if (!room) {
      socket.emit("join-error", { message: "Room not found. Check the code!" });
      return;
    }
    if (room.started) {
      socket.emit("join-error", { message: "Game already started!" });
      return;
    }

    const idx = getPlayerIndex(room);
    const player = {
      name: playerName,
      color: COLORS[idx % COLORS.length],
      emoji: EMOJIS[idx % EMOJIS.length],
      socketId: socket.id
    };

    room.players[socket.id] = player;
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerName = playerName;

    console.log(`${playerName} joined room ${roomCode}`);

    // Tell everyone in lobby about the new player
    broadcastLobby(roomCode);

    // Tell the new player the question details (in case game starts)
    socket.emit("joined-room", { roomCode, player, question: room.question });

    // Tell host specifically
    io.to(room.host).emit("player-joined", { player, totalPlayers: getPlayerIndex(room) });
  });

  // ── HOST starts the game ───────────────────────────────────────────────────
  socket.on("start-game", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.host) return;
    if (Object.keys(room.players).length < 1) {
      socket.emit("start-error", { message: "Need at least 1 player to start!" });
      return;
    }

    room.started = true;

    // Send question + timeLimit to everyone
    io.to(roomCode).emit("game-starting", {
      question: room.question,
      timeLimit: room.timeLimit,
      winCondition: room.winCondition,
      players: getRoomPlayers(room)
    });

    // Start countdown then timer
    let count = 3;
    const countdown = setInterval(() => {
      io.to(roomCode).emit("countdown", { count });
      count--;
      if (count < 0) {
        clearInterval(countdown);
        io.to(roomCode).emit("game-started");
        startRoomTimer(roomCode);
      }
    }, 1000);
  });

  // ── PLAYER submits an answer ───────────────────────────────────────────────
  socket.on("submit-answer", ({ roomCode, answer, timeLeft }) => {
    const room = rooms[roomCode];
    if (!room || room.finished) return;

    const playerName = socket.playerName;
    if (!playerName) return;
    if (room.submissions[playerName]) return; // no double submit

    room.submissions[playerName] = { answer, timeLeft, timestamp: Date.now() };
    console.log(`${playerName} submitted in room ${roomCode}`);

    const totalSubmissions = Object.keys(room.submissions).length;
    const totalPlayers = Object.keys(room.players).length;

    // Tell everyone this player submitted
    io.to(roomCode).emit("player-submitted", {
      playerName, timeLeft, totalSubmissions, totalPlayers
    });

    // Auto-end if everyone submitted
    if (totalSubmissions >= totalPlayers && !room.finished) {
      room.finished = true;
      clearInterval(room.timerInterval);
      // Short delay so last submission toast shows
      setTimeout(() => {
        if (room.winCondition === "judge") {
          io.to(room.host).emit("open-judge-panel", { submissions: room.submissions });
          io.to(roomCode).emit("time-up", { message: "All submitted! Judge is reviewing..." });
        } else {
          // Best by most time left
          const winner = Object.entries(room.submissions)
            .sort((a, b) => b[1].timeLeft - a[1].timeLeft)[0][0];
          endGame(roomCode, winner);
        }
      }, 800);
    }
  });

  // ── HOST awards winner (judge mode) ───────────────────────────────────────
  socket.on("award-winner", ({ roomCode, winnerName }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.host) return;
    endGame(roomCode, winnerName);
  });

  // ── HOST starts next round ─────────────────────────────────────────────────
  socket.on("start-next-round", ({ roomCode, question, timeLimit, winCondition, roundIndex }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.host) return;

    room.question = question;
    room.timeLimit = timeLimit || 120;
    room.winCondition = winCondition || "first";
    room.submissions = {};
    room.finished = false;
    if (room.timerInterval) clearInterval(room.timerInterval);

    io.to(roomCode).emit("next-round-starting", { question, timeLimit, winCondition, roundIndex });

    // Countdown then start
    let count = 3;
    const countdown = setInterval(() => {
      io.to(roomCode).emit("countdown", { count });
      count--;
      if (count < 0) {
        clearInterval(countdown);
        io.to(roomCode).emit("game-started");
        startRoomTimer(roomCode);
      }
    }, 1000);
  });

  // ── HOST ends game manually ────────────────────────────────────────────────
  socket.on("end-game", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.host) return;
    if (room.timerInterval) clearInterval(room.timerInterval);
    io.to(roomCode).emit("game-ended-by-host");
    delete rooms[roomCode];
  });

  // ── Disconnect cleanup ─────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];

    if (socket.isHost) {
      // Host left — kill the room
      if (room.timerInterval) clearInterval(room.timerInterval);
      io.to(roomCode).emit("host-disconnected", { message: "Host left. Room closed." });
      delete rooms[roomCode];
      console.log(`Room ${roomCode} closed (host left)`);
    } else {
      // Player left
      delete room.players[socket.id];
      broadcastLobby(roomCode);
      io.to(room.host).emit("player-left", { playerName: socket.playerName });
      console.log(`${socket.playerName} left room ${roomCode}`);
    }
  });
});

// ── Health check endpoint (Render needs this) ─────────────────────────────────
app.get("/", (req, res) => {
  res.send("CodeRace server is running ✅");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CodeRace server listening on port ${PORT}`);
});
