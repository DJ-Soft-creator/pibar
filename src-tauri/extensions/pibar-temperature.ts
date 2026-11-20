// pibar-temperature.ts — sampling temperature per session, installed by PiBar (temp_install in src-tauri/src/temp.rs).
// PiBar sets the value with "/temperature 0.7" (detached runs: "--temperature 0.7"), "/temperature off" returns to the
// model's default. The value overrides the provider payload right before each request; models that reject temperature
// (extended thinking, some reasoning models) keep their default. Also works in Pi's own terminal.

/** Parse a temperature argument: number 0–2 (comma allowed), "off"/"default" → null, anything else → undefined */
function parseTemp(raw: string): number | null | undefined {
  const s = raw.trim().toLowerCase().replace(",", ".");
  if (!s) return undefined;
  if (["off", "default", "auto", "reset"].includes(s)) return null;
  const v = Number(s);
  if (!Number.isFinite(v) || v < 0 || v > 2) return undefined;
  return Math.round(v * 100) / 100;
}

export default function (pi: any) {
  /** null = the model's default; otherwise the value sent to the provider */
  let temp: number | null = null;

  const statusText = () => (temp === null ? "🌡 default" : `🌡 ${temp}`);
  const report = (ctx: any) => ctx.ui?.setStatus?.("pibar-temperature", statusText());

  // detached runs (PiBar "in the background") start with the value as a flag
  pi.registerFlag("temperature", {
    description: "Sampling temperature for this run (0–2, e.g. 0.7); empty = the model's default",
    type: "string",
    default: "",
  });

  pi.on("session_start", (_event: any, ctx: any) => {
    const flag = parseTemp(String(pi.getFlag?.("temperature") ?? ""));
    if (flag !== undefined) temp = flag;
    report(ctx);
  });

  pi.registerCommand("temperature", {
    description: "Sampling temperature: /temperature 0.7 · /temperature off (model default)",
    handler: async (args: string, ctx: any) => {
      const raw = (args ?? "").trim();
      if (!raw) {
        ctx.ui.notify(temp === null ? "Temperature: model default" : `Temperature: ${temp}`, "info");
        return;
      }
      const v = parseTemp(raw);
      if (v === undefined) {
        ctx.ui.notify(`Temperature: "${raw}" is not a number between 0 and 2 (or "off").`, "warning");
        return;
      }
      temp = v;
      report(ctx);
      ctx.ui.notify(v === null ? "Temperature: back to the model's default." : `Temperature: ${v}`, "info");
    },
  });

  pi.on("before_provider_request", (event: any, ctx: any) => {
    if (temp === null) return;
    const p = event.payload;
    if (!p || typeof p !== "object") return;
    const m = ctx.model;
    // models that reject the field outright (e.g. Claude Opus 4.7+)
    if (m?.compat?.supportsTemperature === false) return;
    // Anthropic: extended thinking requires the default temperature
    const thinking = p.thinking;
    if (thinking && (thinking.type === "enabled" || thinking.type === "adaptive")) return;
    // OpenAI-style reasoning models (responses API) reject temperature as well
    if (m?.reasoning && typeof m?.api === "string" && m.api.includes("responses")) return;
    return { ...p, temperature: temp };
  });
}
