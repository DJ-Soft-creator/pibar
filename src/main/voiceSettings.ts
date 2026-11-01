// Settings → "Voice": dictation (speech to text), read aloud (text to speech) and text improvement by a second LLM.
// Returns the editor element and a getter for the edited copy of AppConfig.voice.
import type { VoiceCfg } from "../shared/api";
import { h, errMsg, type KeysWith } from "../shared/dom";
import { getLang, Msg, t } from "../shared/i18n";
import { DEFAULT_IMPROVE_PROMPT, improve, speak } from "../shared/voice";
import { saveConfig, state } from "./state";

const DICTATION_EXAMPLE =
  "ffmpeg -loglevel error -y -i {file} -ar 16000 -ac 1 /tmp/pibar.wav && whisper-cli -m ~/models/ggml-large-v3-turbo.bin -nt -np -f /tmp/pibar.wav";

function defaults(): VoiceCfg {
  return {
    stt: { provider: "off", baseUrl: "", apiKey: "", model: "whisper-1", language: "", command: "" },
    tts: { provider: "system", baseUrl: "", apiKey: "", model: "gpt-4o-mini-tts", voice: "", autoRead: "off" },
    improve: { enabled: false, afterDictation: false, baseUrl: "", apiKey: "", model: "gpt-4o-mini", prompt: "" },
  };
}

export function voiceEditor(): { el: HTMLElement; get: () => VoiceCfg } {
  const base = defaults();
  const cur = state.config.voice;
  const draft: VoiceCfg = {
    stt: { ...base.stt, ...cur?.stt },
    tts: { ...base.tts, ...cur?.tts },
    improve: { ...base.improve, ...cur?.improve },
  };
  const root = h("div", { class: "voice-set" });

  const row = (label: string, input: HTMLElement) => h("div", { class: "row" }, h("label", {}, label), input);
  const hint = (text: string) => h("p", { class: "hint" }, text);
  function text<T extends object>(obj: T, key: KeysWith<T, string>, ph = "", type = "text") {
    const i = h("input", { type, placeholder: ph, value: String(obj[key] ?? ""), autocomplete: "off" });
    i.addEventListener("input", () => ((obj as Record<typeof key, string>)[key] = i.value));
    return i;
  }
  // the option values are the allowed values of the field
  function select<T extends object>(obj: T, key: keyof T, opts: [string, Msg][], rerender = false) {
    const s = h(
      "select",
      {},
      ...opts.map(([v, l]) => h("option", { value: v, selected: obj[key] === v }, t(l))),
    ) as HTMLSelectElement;
    s.addEventListener("change", () => {
      (obj as Record<typeof key, string>)[key] = s.value;
      if (rerender) render();
    });
    return s;
  }
  function check<T extends object>(obj: T, key: KeysWith<T, boolean>, label: string, rerender = false) {
    const c = h("input", { type: "checkbox", checked: !!obj[key], style: "width:auto" }) as HTMLInputElement;
    c.addEventListener("change", () => {
      (obj as Record<typeof key, boolean>)[key] = c.checked;
      if (rerender) render();
    });
    return h("label", { class: "check" }, c, ` ${label}`);
  }
  const apiRows = (o: { baseUrl: string; apiKey: string; model: string }, modelPh: string) => [
    row(t("API base URL"), text(o, "baseUrl", "https://api.openai.com/v1")),
    row(t("API key"), text(o, "apiKey", t("optional for local servers"), "password")),
    row(t("Model"), text(o, "model", modelPh)),
  ];
  /** Test button: saves first, because Rust reads the settings from disk */
  const tester = (label: string, run: () => Promise<string>) => {
    const out = h("p", { class: "test-result" });
    const btn = h("button", { class: "ghost small", type: "button" }, label);
    btn.addEventListener("click", async () => {
      out.className = "test-result";
      out.textContent = t("Testing … (saves first)");
      state.config.voice = JSON.parse(JSON.stringify(draft));
      await saveConfig();
      try {
        out.textContent = await run();
        out.className = "test-result ok";
      } catch (e) {
        out.className = "test-result err";
        out.textContent = errMsg(e);
      }
    });
    return h("div", { class: "test-line" }, btn, out);
  };

  function render() {
    const s = draft.stt;
    const tt = draft.tts;
    const im = draft.improve;
    const prompt = h("textarea", { rows: 5, placeholder: DEFAULT_IMPROVE_PROMPT }) as HTMLTextAreaElement;
    prompt.value = im.prompt;
    prompt.addEventListener("input", () => (im.prompt = prompt.value));

    root.replaceChildren(
      h("div", { class: "sub-head" }, t("Dictation (speech to text)")),
      row(
        t("Provider"),
        select(
          s,
          "provider",
          [
            ["off", "Off"],
            ["api", "OpenAI-compatible API"],
            ["command", "Local command"],
          ],
          true,
        ),
      ),
      ...(s.provider === "api"
        ? [
            ...apiRows(s, "whisper-1 / gpt-4o-transcribe / whisper-large-v3"),
            row(t("Language"), text(s, "language", t("e.g. de (empty = detect)"))),
            hint(t("Works with OpenAI, Groq and local servers such as speaches or faster-whisper-server.")),
          ]
        : []),
      ...(s.provider === "command"
        ? [
            row(t("Command"), text(s, "command", "whisper-cli … {file}")),
            hint(`${t("{file} is the recording; the command prints the text. Example:")} ${DICTATION_EXAMPLE}`),
          ]
        : []),

      h("div", { class: "sub-head" }, t("Read aloud (text to speech)")),
      row(
        t("Provider"),
        select(
          tt,
          "provider",
          [
            ["system", "System voice"],
            ["api", "OpenAI-compatible API"],
          ],
          true,
        ),
      ),
      ...(tt.provider === "api"
        ? [...apiRows(tt, "gpt-4o-mini-tts / tts-1"), row(t("Speaker voice"), text(tt, "voice", "alloy"))]
        : [row(t("Speaker voice"), text(tt, "voice", t("empty = system default, e.g. Anna")))]),
      row(
        t("Read answers aloud"),
        select(tt, "autoRead", [
          ["off", "Only on click (speaker icon on an answer)"],
          ["quick", "Answers to quick bar messages"],
          ["all", "All answers"],
        ]),
      ),
      tester(t("Test"), async () => {
        await speak(draft, t("Hello, this is Pi."), getLang());
        return t("Done.");
      }),

      h("div", { class: "sub-head" }, t("Text improvement (second LLM)")),
      h(
        "div",
        { class: "checks" },
        check(im, "enabled", t("Show the “improve text” button next to the input"), true),
        im.enabled ? check(im, "afterDictation", t("Improve dictated text automatically")) : null,
      ),
      ...(im.enabled
        ? [
            ...apiRows(im, "gpt-4o-mini / llama3.1 / qwen2.5"),
            hint(t("Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1")),
            h("div", { class: "row top" }, h("label", {}, t("Prompt")), prompt),
            hint(t("Empty = default prompt (shown greyed out).")),
            tester(t("Test"), () =>
              improve(draft, t("so um can you maybe look why the the build is broken and then like fix it")),
            ),
          ]
        : []),
    );
  }
  render();
  return { el: root, get: () => draft };
}
