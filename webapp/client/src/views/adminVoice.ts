// Admin page "Voice" (tasks J1/J2), following src/main/voiceSettings.ts: dictation (speech to text), reading aloud
// (text to speech) and the text improvement by a second LLM. The services are called by the server with these
// settings; API keys are write-only here (the server never hands them out). Dictation with a command runs that
// program inside the webapp's container. Reading aloud can also use the browser's own voice.
import { api } from "@shared/api";
import { errMsg, h } from "@shared/dom";
import { t } from "@shared/i18n";
import { DEFAULT_IMPROVE_PROMPT } from "@shared/voice";
import { loadSharedConfig } from "../sharedConfig";
import { button, field } from "../ui";
import { speakText } from "../voiceInput";
import type { AdminSettings, SaveSettings } from "./adminConfig";
import { checkInput, saveBar, secretInput, selectInput, textInput, type SecretField } from "./adminForm";

interface Draft {
  stt: SecretField & { provider: string; baseUrl: string; model: string; language: string; command: string };
  tts: SecretField & { provider: string; baseUrl: string; model: string; voice: string };
  improve: SecretField & { enabled: boolean; afterDictation: boolean; baseUrl: string; model: string; prompt: string };
  [k: string]: unknown;
}

/** The stored voice settings with the defaults of the desktop for missing fields (TTS: off in the webapp) */
function draftOf(v: AdminSettings["voice"]): Draft {
  const raw = (v ?? {}) as Record<string, unknown>;
  return {
    ...raw,
    stt: { provider: "off", baseUrl: "", model: "", language: "", command: "", ...v?.stt },
    tts: { provider: "off", baseUrl: "", model: "", voice: "", ...v?.tts },
    improve: { enabled: false, afterDictation: false, baseUrl: "", model: "", prompt: "", ...v?.improve },
  };
}

export function renderVoice(root: HTMLElement, settings: AdminSettings, save: SaveSettings) {
  const draft = draftOf(settings.voice);
  const hint = (text: string) => h("p", { class: "hint" }, text);
  const apiFields = (o: Draft["stt"] | Draft["tts"] | Draft["improve"], modelPh: string) => [
    field(t("API base URL"), textInput(o.baseUrl, (v) => (o.baseUrl = v), { placeholder: "https://api.openai.com/v1", inputmode: "url" })),
    field(t("API key"), secretInput(o)),
    field(t("Model"), textInput(o.model, (v) => (o.model = v), { placeholder: modelPh })),
  ];
  const store = () => save({ voice: draft as AdminSettings["voice"] });

  /** Test: saves first (the server reads the stored settings), then runs */
  const tester = (run: () => Promise<string>) => {
    const out = h("p", { class: "small", "aria-live": "polite" });
    const btn = button(t("Test"), () => {
      out.className = "small muted";
      out.textContent = t("Testing … (saves first)");
      store()
        .then(() => loadSharedConfig())
        .then(run)
        .then((s) => {
          out.className = "small";
          out.textContent = s;
        })
        .catch((e: unknown) => {
          out.className = "small error";
          out.textContent = errMsg(e);
        });
    });
    return h("div", { class: "cfg-test" }, btn, out);
  };

  const stt = h("section", { class: "card" });
  const tts = h("section", { class: "card" });
  const imp = h("section", { class: "card" });

  function renderStt() {
    const s = draft.stt;
    stt.replaceChildren(
      h("h2", {}, t("Dictation (speech to text)")),
      field(
        t("Provider"),
        selectInput(
          s.provider,
          [
            ["off", t("Off")],
            ["api", t("OpenAI-compatible API")],
            ["command", t("Command in the webapp container")],
          ],
          (v) => {
            s.provider = v;
            renderStt();
          },
        ),
      ),
      ...(s.provider === "api"
        ? [
            ...apiFields(s, "whisper-1 / gpt-4o-transcribe / whisper-large-v3"),
            field(t("Language"), textInput(s.language, (v) => (s.language = v), { placeholder: t("e.g. de (empty = detect)") })),
            hint(t("Works with OpenAI, Groq and local servers such as speaches or faster-whisper-server.")),
          ]
        : []),
      ...(s.provider === "command"
        ? [
            field(t("Command"), textInput(s.command, (v) => (s.command = v), { placeholder: "whisper-cli … {file}", class: "mono" })),
            hint(t("{file} is the recording; the command prints the text. It runs inside the webapp's Docker container, so the program must be installed there (the standard image has none).")),
          ]
        : []),
      hint(t("In the chat: hold the microphone to talk, or tap to start and tap again to stop.")),
    );
  }

  function renderTts() {
    const s = draft.tts;
    tts.replaceChildren(
      h("h2", {}, t("Read aloud (text to speech)")),
      field(
        t("Provider"),
        selectInput(
          s.provider,
          [
            ["off", t("Off")],
            ["system", t("Voice of the browser")],
            ["api", t("OpenAI-compatible API")],
          ],
          (v) => {
            s.provider = v;
            renderTts();
          },
        ),
      ),
      ...(s.provider === "api"
        ? [...apiFields(s, "gpt-4o-mini-tts / tts-1"), field(t("Speaker voice"), textInput(s.voice, (v) => (s.voice = v), { placeholder: "alloy" }))]
        : []),
      ...(s.provider === "system"
        ? [field(t("Speaker voice"), textInput(s.voice, (v) => (s.voice = v), { placeholder: t("empty = system default, e.g. Anna") }))]
        : []),
      ...(s.provider === "off"
        ? []
        : [
            tester(async () => {
              await speakText(t("Hello, this is Pi."));
              return t("Done.");
            }),
          ]),
    );
  }

  function renderImprove() {
    const s = draft.improve;
    const prompt = h("textarea", { rows: 6, placeholder: DEFAULT_IMPROVE_PROMPT });
    prompt.value = s.prompt;
    prompt.addEventListener("input", () => (s.prompt = prompt.value));
    imp.replaceChildren(
      h("h2", {}, t("Text improvement (second LLM)")),
      checkInput(s.enabled, t("Show the “improve text” button next to the input"), (v) => {
        s.enabled = v;
        renderImprove();
      }),
      ...(s.enabled
        ? [
            checkInput(s.afterDictation, t("Improve dictated text automatically"), (v) => (s.afterDictation = v)),
            ...apiFields(s, "gpt-4o-mini / llama3.1 / qwen2.5"),
            field(t("Prompt"), prompt, t("Empty = default prompt (shown greyed out).")),
            tester(() => api.improveText(t("so um can you maybe look why the the build is broken and then like fix it"), s.prompt.trim() || DEFAULT_IMPROVE_PROMPT)),
          ]
        : []),
    );
  }

  renderStt();
  renderTts();
  renderImprove();
  root.replaceChildren(
    hint(t("The services are called by the server; API keys stay there and are never shown again.")),
    stt,
    tts,
    imp,
    saveBar(async () => {
      const stored = await store();
      // fresh key fields ("stored") after a new key was saved
      renderVoice(root, stored, save);
    }),
  );
}
