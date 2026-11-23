import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static("dist"));

// ------------------------------------------------------------------
// In-Memory Store (in production: DB)
// ------------------------------------------------------------------
interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: "admin" | "user";
}

const users: Record<string, User> = {};

interface Session {
  id: string;
  name: string;
  color: string;
  group?: string;
  pinned: boolean;
  status: "active" | "archived";
  createdAt: string;
}

const sessions: Session[] = [];

// ------------------------------------------------------------------
// WebSocket: Chat & Config Exchange
// ------------------------------------------------------------------
const wss = new WebSocketServer({ server: app, path: "/ws" });

wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (raw: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Chat messages
    if (msg.type === "chat") {
      broadcastChat(msg);
    }
    // Config sync
    else if (msg.type === "config/sync") {
      handleConfigSync(ws, msg.payload);
    }
  });
});

function broadcastChat(msg: any) {
  wss.clients().forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(msg));
    }
  });
}

function handleConfigSync(ws: WebSocket, payload: any) {
  console.log("[configExchange] Received config sync:", JSON.stringify(payload).slice(0, 200));
  ws.send(JSON.stringify({ status: "ok", message: "Config received" }));
}

// ------------------------------------------------------------------
// REST API
// ------------------------------------------------------------------
app.get("/api/users", (_req, res) => {
  const userList: Array<{ id: string; username: string; role: string }> = Object.values(users).map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
  }));
  res.json(userList);
});

app.post("/api/users", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }
  // Simple hash check (in production: bcrypt)
  const passwordHash = Buffer.from(password).toString("base64");
  const id = crypto.randomUUID();
  users[id] = {
    id,
    username,
    passwordHash,
    role: "user",
  };
  res.json({ id, username, role: "user" });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || user.passwordHash !== Buffer.from(password).toString("base64")) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  // Simple session token
  const token = crypto.randomUUID();
  res.json({ token, username: user.username, role: user.role });
});

app.get("/api/sessions", (_req, res) => {
  res.json(sessions);
});

app.post("/api/sessions", (req, res) => {
  const { name, color, group } = req.body;
  const session: Session = {
    id: crypto.randomUUID(),
    name,
    color: color || "#888888",
    group,
    pinned: false,
    status: "active",
    createdAt: new Date().toISOString(),
  };
  sessions.push(session);
  res.json(session);
});

app.get("/api/sessions/:id", (req, res) => {
  const session = sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  res.json(session);
});

app.get("/api/config", (_req, res) => {
  res.json({
    sessions,
    users: Object.values(users),
  });
});

// ------------------------------------------------------------------
// Server start
// ------------------------------------------------------------------
const PORT = process.env.PORT ?? 8787;
app.listen(PORT, () => {
  console.log(`Webapp listening on http://localhost:${PORT}`);
});
