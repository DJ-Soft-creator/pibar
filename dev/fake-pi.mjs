#!/usr/bin/env node
// Fake Pi for development: speaks Pi's RPC protocol and simulates
// streaming, thinking and tool calls – no API key needed.
// Enter it as a host's Pi command in the settings: node /path/to/dev/fake-pi.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--list-models")) {
  console.log("provider  model       context  max-out  thinking  images");
  console.log("fake      fake-fast   128K     8K       no        no");
  console.log("fake      fake-smart  200K     64K      yes       yes");
  process.exit(0);
}
const sessionArg = args.includes("--session") ? args[args.indexOf("--session") + 1] : null;
const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "--fake--");
fs.mkdirSync(dir, { recursive: true });

const id = Math.random().toString(16).slice(2, 10);
let sessionFile = sessionArg ?? path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
let messages = [];
let written = false;
if (sessionArg && fs.existsSync(sessionArg)) {
  for (const line of fs.readFileSync(sessionArg, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.type === "message") messages.push(e.message);
    } catch {
      // skip empty or broken lines
    }
  }
  written = true;
}

const models = [
  { id: "fake-fast", name: "Fake Schnell", provider: "fake", reasoning: false },
  { id: "fake-smart", name: "Fake Schlau", provider: "fake", reasoning: true },
];
let model = models[1];
let thinkingLevel = "medium";
let streaming = false;
let aborted = false;
// temperature extension (pibar-temperature): null = model default, "--temperature 0.7" sets the start value
let temperature = null;
const tempFlag = args.includes("--temperature") ? args[args.indexOf("--temperature") + 1] : "";
if (tempFlag && Number.isFinite(Number(tempFlag))) temperature = Number(tempFlag);
const tempStatus = () =>
  out({
    type: "extension_ui_request",
    id: "temp-" + Date.now(),
    method: "setStatus",
    statusKey: "pibar-temperature",
    statusText: temperature === null ? "🌡 default" : `🌡 ${temperature}`,
  });

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const reply = (req, data) => out({ id: req.id, type: "response", command: req.type, success: true, data });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function persist(msg) {
  if (!written) {
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() }) +
        "\n",
    );
    written = true;
  }
  fs.appendFileSync(sessionFile, JSON.stringify({ type: "message", message: msg }) + "\n");
}

async function run(text, images = []) {
  streaming = true;
  aborted = false;
  out({ type: "agent_start" });
  const user = { role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() };
  messages.push(user);
  persist(user);
  out({ type: "message_start", message: user });
  out({ type: "message_end", message: user });

  // 1. assistant: thinks, calls a tool
  const a1 = { role: "assistant", content: [], provider: "fake", model: model.id };
  out({ type: "message_start", message: a1 });
  const thought = `The user asks: "${text}". Let me look at the folder first.`;
  for (const w of thought.split(/(?<= )/)) {
    if (aborted) break;
    out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: w } });
    await sleep(25);
  }
  const call = { type: "toolCall", id: "call_" + id + messages.length, name: "bash", arguments: { command: "ls -la" } };
  out({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: call.id, toolName: "bash" },
  });
  out({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"command":"ls -la"}' },
  });
  out({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: call } });
  a1.content = [{ type: "thinking", thinking: thought }, call];
  a1.usage = { totalTokens: 812, cost: { total: 0.004 } };
  a1.stopReason = "toolUse";
  out({ type: "message_end", message: a1 });
  messages.push(a1);
  persist(a1);

  out({ type: "tool_execution_start", toolCallId: call.id, toolName: "bash", args: call.arguments });
  await sleep(400);
  let listing;
  try {
    listing = fs.readdirSync(process.cwd()).slice(0, 15).join("\n");
  } catch (e) {
    listing = String(e);
  }
  const result = { content: [{ type: "text", text: listing }] };
  out({ type: "tool_execution_end", toolCallId: call.id, toolName: "bash", result, isError: false, durationMs: 400 });
  const tr = { role: "toolResult", toolCallId: call.id, toolName: "bash", content: result.content, isError: false };
  messages.push(tr);
  persist(tr);

  // 2. assistant: answer as Markdown
  const a2 = { role: "assistant", content: [], provider: "fake", model: model.id };
  out({ type: "message_start", message: a2 });
  const answer = `Here is my answer (model **${model.name}**, thinking *${thinkingLevel}*).\n\nThe folder \`${process.cwd()}\` has ${listing.split("\n").length} entries.\n\n- Point one\n- Point two\n\n\`\`\`ts\nconst greeting = "Hello world";\nconsole.log(greeting);\n\`\`\`\n\nDone.`;
  let sent = "";
  for (const w of answer.split(/(?<= )/)) {
    if (aborted) break;
    sent += w;
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: w } });
    await sleep(30);
  }
  a2.content = [{ type: "text", text: sent }];
  a2.usage = { totalTokens: 1450, cost: { total: 0.011 } };
  a2.stopReason = aborted ? "aborted" : "stop";
  out({ type: "message_end", message: a2 });
  messages.push(a2);
  persist(a2);

  out({ type: "agent_end", messages: [] });
  streaming = false;
  out({ type: "agent_settled", aborted });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  switch (req.type) {
    case "get_state":
      return reply(req, {
        model,
        thinkingLevel,
        isStreaming: streaming,
        isCompacting: false,
        sessionFile,
        sessionId: id,
        messageCount: messages.length,
        pendingMessageCount: 0,
      });
    case "get_available_models":
      return reply(req, { models });
    case "get_available_thinking_levels":
      return reply(req, { levels: model.reasoning ? ["off", "low", "medium", "high"] : ["off"] });
    case "set_model":
      model = models.find((m) => m.id === req.modelId) ?? model;
      if (!model.reasoning) thinkingLevel = "off";
      return reply(req, model);
    case "set_thinking_level":
      thinkingLevel = req.level;
      return reply(req);
    case "get_messages":
      return reply(req, { messages });
    case "get_commands":
      return reply(req, { commands: [{ name: "temperature", description: "Sampling temperature (fake)" }] });
    case "abort":
      aborted = true;
      return reply(req);
    case "prompt": {
      const text = req.message ?? "";
      // the temperature extension handles its command itself (disposition "handled")
      if (text.trimStart().startsWith("/temperature")) {
        const arg = (text.trim().split(/\s+/)[1] ?? "").toLowerCase().replace(",", ".");
        let message;
        if (!arg) message = temperature === null ? "Temperature: model default" : `Temperature: ${temperature}`;
        else if (["off", "default", "auto", "reset"].includes(arg)) {
          temperature = null;
          message = "Temperature: back to the model's default.";
        } else if (Number.isFinite(Number(arg)) && Number(arg) >= 0 && Number(arg) <= 2) {
          temperature = Math.round(Number(arg) * 100) / 100;
          message = `Temperature: ${temperature}`;
        } else message = `Temperature: "${arg}" is not a number between 0 and 2 (or "off").`;
        reply(req, { disposition: "handled" });
        tempStatus();
        out({ type: "extension_ui_request", id: "temp-notify-" + Date.now(), method: "notify", message });
        return;
      }
      reply(req, { disposition: streaming ? "queued" : "started" });
      if (!streaming) run(text, req.images ?? []);
      return;
    }
    default:
      return out({
        id: req.id,
        type: "response",
        command: req.type,
        success: false,
        error: `Unbekannter Befehl: ${req.type}`,
      });
  }
});

// the extension reports its start value once (like session_start of pibar-temperature)
tempStatus();
