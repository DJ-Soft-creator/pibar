// Voice (tasks J1/J2): the Rust test cases of voice.rs, calls against a fake OpenAI-compatible server (key only in the
// Authorization header, multipart upload with the right file type, error texts), the dictation command in the
// container, and the commands with the settings of the AppConfigStore (switched off = refused, keys stay secret).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigStore } from "../src/server/appConfig.js";
import { CommandRegistry } from "../src/server/commands.js";
import { registerVoiceCommands } from "../src/server/cmd/voice.js";
import {
  apiUrl,
  errorText,
  extForMime,
  improve,
  parseChat,
  parseTranscript,
  speak,
  stripThink,
  transcribe,
  voiceSettings,
} from "../src/server/voice.js";

interface Seen {
  url: string;
  auth: string | undefined;
  type: string | undefined;
  body: Buffer;
}

/** Fake OpenAI-compatible API: answers per path, remembers the requests */
async function fakeApi(t: TestContext, answer: (req: IncomingMessage, body: Buffer) => [number, string, string?]) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, type: req.headers["content-type"], body });
      const [status, text, type] = answer(req, body);
      res.writeHead(status, { "Content-Type": type ?? "application/json" });
      res.end(text);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`, seen };
}

test("voice.rs cases: urls, mime → extension, think blocks, answers", () => {
  assert.equal(apiUrl("", "audio/speech"), "https://api.openai.com/v1/audio/speech");
  assert.equal(apiUrl("http://mini:8000/v1/", "chat/completions"), "http://mini:8000/v1/chat/completions");
  assert.equal(extForMime("audio/webm;codecs=opus"), "webm");
  assert.equal(extForMime("audio/mp4"), "m4a");
  assert.equal(extForMime("audio/wav"), "wav");
  assert.equal(stripThink("<think>hmm</think>\n\nHello"), "Hello");
  assert.equal(stripThink("Hello"), "Hello");
  assert.equal(parseTranscript('{"text":" Hallo Welt "}'), "Hallo Welt");
  assert.equal(parseTranscript("plain text\n"), "plain text");
  assert.equal(parseChat({ choices: [{ message: { content: "Better." } }] }), "Better.");
  assert.equal(parseChat({}), null);
  assert.equal(errorText(401, '{"error":{"message":"Invalid key"}}'), "Invalid key");
  assert.equal(errorText(500, "boom"), "HTTP 500 boom");
});

test("voiceSettings: defaults for missing fields, wrong types ignored", () => {
  const v = voiceSettings({ stt: { provider: "api", model: 3 }, improve: { enabled: "yes" } });
  assert.equal(v.stt.provider, "api");
  assert.equal(v.stt.model, "");
  assert.equal(v.tts.provider, "off");
  assert.equal(v.improve.enabled, false);
  assert.equal(voiceSettings(null).stt.provider, "off");
});

test("transcribe over the API: multipart with the recording's type, key as Bearer, language", async (t) => {
  const api = await fakeApi(t, () => [200, '{"text":" Hallo "}']);
  const cfg = { provider: "api", baseUrl: api.base, apiKey: "sk-test", model: "", language: "de", command: "" };
  const text = await transcribe(cfg, Buffer.from("fake audio").toString("base64"), "audio/mp4");
  assert.equal(text, "Hallo");
  const req = api.seen[0];
  assert.equal(req?.url, "/v1/audio/transcriptions");
  assert.equal(req?.auth, "Bearer sk-test");
  assert.match(req?.type ?? "", /^multipart\/form-data/);
  const body = req?.body.toString("latin1") ?? "";
  assert.match(body, /filename="recording\.m4a"/);
  assert.match(body, /Content-Type: audio\/mp4/);
  assert.match(body, /name="model"\r\n\r\nwhisper-1/);
  assert.match(body, /name="language"\r\n\r\nde/);
  assert.match(body, /fake audio/);
});

test("improve and speak: JSON bodies, no key header without a key, API errors as text", async (t) => {
  const api = await fakeApi(t, (req) => {
    if (req.url === "/v1/chat/completions") return [200, '{"choices":[{"message":{"content":"<think>x</think>Besser."}}]}'];
    if (req.url?.endsWith("audio/speech")) return [200, "MP3DATA", "audio/mpeg"];
    return [404, '{"error":{"message":"nope"}}'];
  });
  const im = { enabled: true, afterDictation: false, baseUrl: api.base, apiKey: "", model: "m", prompt: "" };
  assert.equal(await improve(im, "Fix it", "so um fix"), "Besser.");
  assert.equal(api.seen[0]?.auth, undefined);
  const sent = JSON.parse(api.seen[0]?.body.toString() ?? "{}") as { model: string; messages: { role: string; content: string }[] };
  assert.equal(sent.model, "m");
  assert.deepEqual(sent.messages.map((m) => m.role), ["system", "user"]);
  const audio = await speak({ provider: "api", baseUrl: api.base, apiKey: "k", model: "", voice: "", }, "Hallo");
  assert.deepEqual(audio, { data: Buffer.from("MP3DATA").toString("base64"), mimeType: "audio/mpeg" });
  const sp = JSON.parse(api.seen[1]?.body.toString() ?? "{}") as Record<string, string>;
  assert.equal(sp.voice, "alloy");
  assert.equal(sp.model, "gpt-4o-mini-tts");
  assert.equal(sp.response_format, "mp3");
  await assert.rejects(improve({ ...im, baseUrl: `${api.base}x/` }, "p", "t"), /nope/);
  await assert.rejects(speak({ provider: "api", baseUrl: "http://127.0.0.1:1/v1", apiKey: "", model: "", voice: "" }, "x"), /not reachable/);
});

test("transcribe with a command in the container: {file} is the quoted recording", async () => {
  const cfg = { provider: "command", baseUrl: "", apiKey: "", model: "", language: "", command: "printf 'got %s' \"$(cat {file})\"" };
  assert.equal(await transcribe(cfg, Buffer.from("it's me").toString("base64"), "audio/webm"), "got it's me");
  await assert.rejects(transcribe({ ...cfg, command: " " }, "", "audio/webm"), /No dictation command/);
  await assert.rejects(transcribe({ ...cfg, command: "echo bad >&2; exit 3" }, "", "audio/webm"), /bad/);
  await assert.rejects(transcribe({ ...cfg, provider: "off" }, "", "audio/webm"), /off/);
});

test("voice commands: settings from the store, off = refused, secrets stay on the server", async (t) => {
  const api = await fakeApi(t, (req) =>
    req.url?.endsWith("chat/completions") ? [200, '{"choices":[{"message":{"content":"Better"}}]}'] : [200, '{"text":"Hi"}'],
  );
  const dir = mkdtempSync(join(tmpdir(), "pibar-voice-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = new AppConfigStore(dir);
  const reg = new CommandRegistry();
  registerVoiceCommands(reg, { appConfig: cfg });
  const run = (name: string, args: Record<string, unknown>) => Promise.resolve().then(() => reg.get(name)?.run({} as never, args));
  await assert.rejects(run("transcribe_audio", { data: "AAAA", mime: "audio/mp4" }), /Dictation is off/);
  await assert.rejects(run("improve_text", { text: "x", prompt: "p" }), /improvement is off/);
  await assert.rejects(run("speak_text", { text: "x" }), /off/);
  cfg.save({
    ...cfg.settings,
    voice: {
      stt: { provider: "api", baseUrl: api.base, apiKey: "sk-secret" },
      improve: { enabled: true, baseUrl: api.base, apiKey: "sk-secret", model: "m", prompt: "Admin prompt" },
    },
  });
  assert.equal(await run("transcribe_audio", { data: "AAAA", mime: "audio/mp4" }), "Hi");
  assert.equal(api.seen[0]?.auth, "Bearer sk-secret");
  assert.equal(await run("improve_text", { text: "x", prompt: "client prompt" }), "Better");
  const sent = JSON.parse(api.seen[1]?.body.toString() ?? "{}") as { messages: { content: string }[] };
  assert.equal(sent.messages[0]?.content, "Admin prompt");
  await assert.rejects(run("transcribe_audio", { data: "not base64!", mime: "audio/mp4" }), /base64/);
  assert.doesNotMatch(JSON.stringify(cfg.publicConfig()), /sk-secret/);
});
