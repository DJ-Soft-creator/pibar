/* ------------------------------------------------------------------ */
/*  Pibar Webapp – Mobile-optimiert für iPhone                       */
/*  Features: Login, Chat, View, Projekt-Editor, MD-Editor, Upload    */
/* ------------------------------------------------------------------ */

// ---------- State ----------
let user = null;
let sessions = [];
let currentView = "natural";
let configStatus = "";

// ---------- DOM ----------
const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const loginError = document.getElementById("login-error");
const loginBtn = document.getElementById("login-btn");

const viewBtn = document.getElementById("view-btn");
const configBtn = document.getElementById("config-btn");
const logoutBtn = document.getElementById("logout-btn");
const sessionList = document.getElementById("session-list");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const viewTabs = document.querySelectorAll(".view-tab");
const viewOptions = document.querySelectorAll(".view-option");
const viewContent = document.getElementById("view-content");
const projectEditor = document.getElementById("project-editor");
const projectText = document.getElementById("project-text");
const saveProjectBtn = document.getElementById("save-project-btn");
const mdText = document.getElementById("md-text");
const mdPreviewBtn = document.getElementById("md-preview-btn");
const mdDownloadBtn = document.getElementById("md-download-btn");
const configModal = document.getElementById("config-modal");
const configExportBtn = document.getElementById("config-export-btn");
const configImportBtn = document.getElementById("config-import-btn");
const configStatusEl = document.getElementById("config-status");

// ---------- Auth ----------
async function login(username, password) {
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");
    user = { username, role: data.role };
    loginError.textContent = "";
    showApp();
  } catch (e) {
    loginError.textContent = e.message;
  }
}

function showApp() {
  loginScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  loadSessions();
}

loginBtn.addEventListener("click", () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) {
    loginError.textContent = "Benutzername und Passwort erforderlich";
    return;
  }
  login(username, password);
});

// ---------- Session Management ----------
async function loadSessions() {
  try {
    const res = await fetch("/api/sessions");
    sessions = await res.json();
    renderSessionList();
  } catch (e) {
    console.error("Failed to load sessions:", e);
  }
}

function renderSessionList() {
  sessionList.innerHTML = "";
  sessions.forEach((s) => {
    const li = document.createElement("li");
    li.className = "session-item";
    li.style.color = s.color;
    li.innerHTML = `
      <span class="session-color" style="background:${s.color}"></span>
      <span class="session-name">${escapeHtml(s.name)}</span>
      ${s.pinned ? '<span class="badge badge-pin">PIN</span>' : ""}
      ${s.group ? `<span class="badge badge-group">${escapeHtml(s.group)}</span>` : ""}
    `;
    li.addEventListener("click", () => openSession(s.id));
    sessionList.appendChild(li);
  });
}

async function openSession(sessionId) {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  projectEditor.classList.remove("hidden");
  projectText.value = session.name;
  showConfigModal();
}

// ---------- Chat ----------
function appendChatMessage(text, sender = "Pi") {
  const div = document.createElement("div");
  div.className = "chat-message";
  div.innerHTML = `<strong>${escapeHtml(sender)}:</strong> ${escapeHtml(text)}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  appendChatMessage(text, user?.username || "Pi");
  chatInput.value = "";

  // Send to PiBar via WebSocket
  try {
    const ws = new WebSocket(`ws://localhost:8787/chat`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "chat", text, model: "qwen4-max-preview" }));
    };
    ws.onclose = () => {};
  } catch {}
}

sendBtn.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) sendMessage();
});

// ---------- View ----------
function setView(view) {
  currentView = view;
  viewTabs.forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  viewOptions.forEach((o) => o.classList.toggle("active", o.dataset.view === view));
  viewContent.classList.toggle("hidden", view !== view);
}

viewTabs.forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
viewOptions.forEach((o) => o.addEventListener("click", () => setView(o.dataset.view)));

// ---------- Project Editor ----------
function saveProject() {
  fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: user?.username || "Session", color: "#888888", group: "" }),
  }).then(() => alert("Projekt gespeichert"));
}

saveProjectBtn.addEventListener("click", saveProject);

// ---------- MD Editor ----------
function renderMarkdown(text) {
  const div = document.createElement("div");
  div.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
  return div;
}

mdPreviewBtn.addEventListener("click", () => {
  mdPreviewBtn.textContent = "Markdown-Editor";
  mdPreviewBtn.disabled = true;
});

mdDownloadBtn.addEventListener("click", () => {
  const blob = new Blob([mdText.value], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "document.md";
  a.click();
  URL.revokeObjectURL(url);
});

// ---------- Config Exchange ----------
function showConfigModal() {
  configModal.classList.remove("hidden");
  configStatusEl.textContent = "";
}

configExportBtn.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/config/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions, users: sessions.map((s) => s.id) }),
    });
    const data = await res.json();
    configStatusEl.textContent = data.message || "Exportiert";
  } catch (e) {
    configStatusEl.textContent = "Fehler beim Export";
  }
});

configImportBtn.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/config/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions: [], users: [] }),
    });
    configStatusEl.textContent = "Importiert";
  } catch (e) {
    configStatusEl.textContent = "Import fehlgeschlagen";
  }
});

// ---------- Logout ----------
logoutBtn.addEventListener("click", () => {
  user = null;
  loginError.textContent = "";
  showApp();
});

// ---------- Helpers ----------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

showApp();
