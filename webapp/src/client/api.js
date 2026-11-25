/* ------------------------------------------------------------------ */
/*  PiBar Webapp – API-Schicht gegen den Express-Backend-Contract      */
/* ------------------------------------------------------------------ */

const TOKEN_KEY = "pibar.token";
const USER_KEY = "pibar.user";

let unauthorizedHandler = null;

/** Wird vom App-Modul gesetzt: Token ist weg -> Login zeigen. */
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const auth = {
  getToken() {
    return safeGet(TOKEN_KEY);
  },
  getUser() {
    try {
      const raw = safeGet(USER_KEY);
      const user = raw ? JSON.parse(raw) : null;
      return user && typeof user.username === "string" ? user : null;
    } catch {
      return null;
    }
  },
  setSession(token, user) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch {
      /* ohne localStorage läuft die App nur bis zum Reload */
    }
  },
  clearSession() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {
      /* ignorieren */
    }
  },
};

export class ApiError extends Error {
  constructor(status, serverMessage) {
    const defaults = {
      0: "Server nicht erreichbar",
      401: "Nicht autorisiert",
      403: "Keine Berechtigung",
      404: "Nicht gefunden",
    };
    super(serverMessage || defaults[status] || `Serverfehler (${status})`);
    this.status = status;
    this.serverMessage = serverMessage || null;
  }
}

async function request(path, { method = "GET", body, auth: withAuth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = auth.getToken();
  if (withAuth && token) headers["Authorization"] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0);
  }

  let data = null;
  try {
    const text = await res.text();
    if (text) data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (res.status === 401 && withAuth) {
    auth.clearSession();
    if (unauthorizedHandler) unauthorizedHandler();
    throw new ApiError(401, data && data.error);
  }
  if (!res.ok) {
    throw new ApiError(res.status, data && typeof data.error === "string" ? data.error : null);
  }
  return data;
}

export const api = {
  login: (username, password) =>
    request("/api/login", { method: "POST", body: { username, password }, auth: false }),
  logout: () => request("/api/logout", { method: "POST" }),
  sessions: () => request("/api/sessions"),
  configStatus: () => request("/api/config/status", { auth: false }),
  config: () => request("/api/config", { auth: false }),
  users: () => request("/api/users"),
  createUser: (user) => request("/api/users", { method: "POST", body: user }),
  updateUser: (id, patch) =>
    request(`/api/users/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  deleteUser: (id) =>
    request(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" }),
  hosts: () => request("/api/hosts"),
  createHost: (host) => request("/api/hosts", { method: "POST", body: host }),
  updateHost: (id, patch) =>
    request(`/api/hosts/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  deleteHost: (id) =>
    request(`/api/hosts/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/**
 * WebSocket /ws mit Reconnect-Backoff (1 s … 30 s, jitter).
 * Liefert { close }. Events: echte Server-Messages plus
 * {type:"ws/open"} / {type:"ws/close"} für die Statusanzeige.
 */
export function openSocket(onEvent) {
  let ws = null;
  let attempt = 0;
  let timer = null;
  let closed = false;

  function schedule() {
    if (closed) return;
    const delay = Math.min(30000, 1000 * 2 ** attempt);
    attempt += 1;
    timer = setTimeout(connect, delay + Math.random() * 500);
  }

  function connect() {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => {
      attempt = 0;
      onEvent({ type: "ws/open" });
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && typeof msg.type === "string") onEvent(msg);
    };
    ws.onclose = () => {
      onEvent({ type: "ws/close" });
      schedule();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignorieren */
      }
    };
  }

  connect();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* ignorieren */
        }
      }
    },
  };
}