// Admin page "Chat colours" (task I5), following src/main/colorSettings.ts and src/main/sessionColorSettings.ts:
// colour profiles for thinking, tool calls, answers and own messages (one set for dark, one for light, hex values,
// empty = the theme's colour) with a live preview, which profile hosts without their own use (`isDefault`), the
// profile of each host, and the short descriptions of the eight session colours.
import { cleanColor, cleanProfiles, fullHex, ROLES, type ChatColors, type Role } from "@shared/colors";
import { errMsg, h, toast } from "@shared/dom";
import { t, type Msg } from "@shared/i18n";
import { cleanColorLabels, COLOR_NAMES, COLORS, LABEL_MAX } from "@shared/sessionColors";
import { hosts as hostApi } from "../rest";
import { loadSharedConfig, sharedConfig, type WebColorProfile } from "../sharedConfig";
import { state } from "../state";
import { button, field } from "../ui";
import type { AdminSettings, SaveSettings } from "./adminConfig";
import { saveBar, selectInput, textInput } from "./adminForm";

const ROLE_LABELS: Record<Role, Msg> = {
  thinking: "Thinking",
  tools: "Tool calls",
  answer: "Answers",
  own: "Your messages",
};

/** Profiles cleaned like on the desktop, the default flag kept on the chosen one */
export function cleanWebProfiles(list: WebColorProfile[], fallback: string): WebColorProfile[] {
  return cleanProfiles(list).map((p) => (p.id === fallback ? { ...p, isDefault: true } : p));
}

/**
 * Colour profile choice of the host dialog (admin.ts): "" = the default profile; filled from the shared settings
 * (loaded if needed). The current value stays selectable even before the list is there.
 */
export function colorProfileSelect(value: string): HTMLSelectElement {
  const s = h("select", {});
  const fill = (profiles: WebColorProfile[]) => {
    const keep = s.value || value;
    const def = profiles.find((p) => p.isDefault);
    const opts: [string, string][] = [
      ["", def ? t("Default ({name})", { name: def.name || t("(unnamed)") }) : t("Theme colours")],
      ...profiles.map((p): [string, string] => [p.id, p.name || t("(unnamed)")]),
    ];
    if (keep && !profiles.some((p) => p.id === keep)) opts.push([keep, keep]);
    s.replaceChildren(...opts.map(([v, l]) => h("option", { value: v }, l)));
    s.value = keep;
  };
  const cfg = sharedConfig();
  fill(cfg?.colorProfiles ?? []);
  if (!cfg) void loadSharedConfig().then((c) => c && fill(c.colorProfiles ?? []));
  return s;
}

export function renderColors(root: HTMLElement, settings: AdminSettings, save: SaveSettings) {
  const draft: WebColorProfile[] = JSON.parse(JSON.stringify(settings.colorProfiles ?? [])) as WebColorProfile[];
  let fallback = draft.find((p) => p.isDefault)?.id ?? "";
  let cur = 0;
  let dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;
  const hostChoice = new Map(state.hosts.map((x) => [x.id, x.colorProfile ?? ""]));
  const labels: Record<string, string> = { ...(settings.sessionColorLabels ?? {}) };

  const current = (): WebColorProfile | undefined => draft[cur];
  const set = (): ChatColors => {
    const p = current();
    if (!p) return {};
    return (p[dark ? "dark" : "light"] ??= {});
  };

  const editor = h("div", { class: "cfg-colors" });
  const hostsCard = h("section", { class: "card" });

  // ---------------------------------------------------------------- one profile
  function colorField(role: Role, key: "background" | "text", onChange: () => void) {
    const value = () => cleanColor(set()[role]?.[key]);
    const text = textInput(
      value(),
      (v) => {
        const c = cleanColor(v);
        (set()[role] ??= {})[key] = c;
        // an unfinished entry (e.g. "#12") stays in the field, the profile keeps the last valid colour
        const hex = fullHex(c);
        if (hex) swatch.value = hex;
        text.classList.toggle("bad", !!v.trim() && !c);
        onChange();
      },
      { class: "cfg-hex", placeholder: "#rrggbb", "aria-label": `${t(ROLE_LABELS[role])} · ${key === "text" ? t("Text") : t("Background")}` },
    );
    const swatch = h("input", { type: "color", class: "cfg-swatch", value: fullHex(value()) || "#808080", "aria-label": t("Pick a colour") });
    swatch.addEventListener("input", () => {
      text.value = swatch.value;
      text.classList.remove("bad");
      (set()[role] ??= {})[key] = swatch.value;
      onChange();
    });
    return h("div", { class: "cfg-color-field" }, text, swatch);
  }

  /** How the four parts look with the colours of the set being edited */
  function preview(): { el: HTMLElement; paint: () => void } {
    const box = h("div", { class: "cfg-preview", "aria-hidden": "true" });
    const paint = () => {
      const s = set();
      const line = (role: Role, sample: string) => {
        const el = h("div", { class: `cfg-prev cfg-prev-${role}` }, sample);
        const bg = cleanColor(s[role]?.background);
        const fg = cleanColor(s[role]?.text);
        if (bg) el.style.background = bg;
        if (fg) el.style.color = fg;
        return el;
      };
      box.classList.toggle("dark", dark);
      box.replaceChildren(
        line("own", t("Your messages")),
        line("thinking", t("Thinking")),
        line("tools", t("Tool calls")),
        line("answer", t("Answers")),
      );
    };
    paint();
    return { el: box, paint };
  }

  function renderEditor() {
    cur = Math.min(Math.max(0, cur), Math.max(0, draft.length - 1));
    const p = current();
    const picker = selectInput(
      String(cur),
      draft.map((x, i): [string, string] => [String(i), x.name || t("(unnamed)")]),
      (v) => {
        cur = Number(v);
        renderEditor();
      },
    );
    picker.disabled = !draft.length;
    const head = h(
      "div",
      { class: "cfg-color-head" },
      picker,
      h(
        "div",
        { class: "row-actions" },
        button(t("+ Add profile"), () => {
          draft.push({ id: `color${Date.now()}`, name: t("New profile"), dark: {}, light: {} });
          cur = draft.length - 1;
          renderEditor();
          renderHosts();
        }),
        p
          ? button(
              t("Remove"),
              () => {
                const gone = draft.splice(cur, 1)[0];
                if (gone && fallback === gone.id) fallback = "";
                for (const [id, prof] of hostChoice) if (gone && prof === gone.id) hostChoice.set(id, "");
                cur -= 1;
                renderEditor();
                renderHosts();
              },
              "danger",
            )
          : null,
      ),
    );
    if (!p) {
      editor.replaceChildren(head, h("p", { class: "hint" }, t("No colour profile yet – add one to colour the chat.")));
      return;
    }
    const prev = preview();
    const repaint = prev.paint;
    const name = textInput(
      p.name,
      (v) => {
        p.name = v;
        const opt = picker.options[picker.selectedIndex];
        if (opt) opt.textContent = v || t("(unnamed)");
        renderHosts();
      },
      { placeholder: t("Name of the profile"), autocapitalize: "sentences" },
    );
    const seg = (isDark: boolean, label: string) =>
      h(
        "button",
        {
          type: "button",
          class: `cfg-seg-btn${dark === isDark ? " active" : ""}`,
          "aria-pressed": String(dark === isDark),
          onclick: () => {
            dark = isDark;
            renderEditor();
          },
        },
        label,
      );
    editor.replaceChildren(
      head,
      field(t("Name"), name),
      h("div", { class: "cfg-theme" }, h("span", { class: "muted" }, t("Colours for")), h("div", { class: "cfg-seg" }, seg(true, t("Dark")), seg(false, t("Light")))),
      ...ROLES.map((role) =>
        h(
          "div",
          { class: "cfg-color-row" },
          h("div", { class: "cfg-role" }, t(ROLE_LABELS[role])),
          h(
            "div",
            { class: "cfg-color-pair" },
            h("div", {}, h("span", { class: "field-label" }, t("Background")), colorField(role, "background", repaint)),
            h("div", {}, h("span", { class: "field-label" }, t("Text")), colorField(role, "text", repaint)),
          ),
        ),
      ),
      prev.el,
    );
  }

  // ---------------------------------------------------------------- default and hosts
  function renderHosts() {
    const profiles = draft.map((p): [string, string] => [p.id, p.name || t("(unnamed)")]);
    const def = draft.find((p) => p.id === fallback);
    hostsCard.replaceChildren(
      h("h2", {}, t("Hosts")),
      field(
        t("Profile for hosts without their own"),
        selectInput(fallback, [["", t("Theme colours")], ...profiles], (v) => {
          fallback = v;
          renderHosts();
        }),
      ),
      ...state.hosts.map((host) =>
        field(
          host.name,
          selectInput(
            hostChoice.get(host.id) ?? "",
            [["", def ? t("Default ({name})", { name: def.name || t("(unnamed)") }) : t("Theme colours")], ...profiles],
            (v) => hostChoice.set(host.id, v),
          ),
        ),
      ),
      ...(state.hosts.length ? [] : [h("p", { class: "muted" }, t("No hosts yet."))]),
    );
  }

  // ---------------------------------------------------------------- session colour descriptions
  const inputs: HTMLInputElement[] = [];
  const labelsCard = h(
    "section",
    { class: "card" },
    h("h2", {}, t("Session colours")),
    h(
      "p",
      { class: "hint" },
      t('A short description per colour (1–3 words, e.g. "Urgent"). It appears as a tooltip and in the colour menu; empty keeps the colour name.'),
    ),
    ...COLORS.map((c) => {
      const input = textInput(labels[c] ?? "", (v) => (labels[c] = v), {
        placeholder: t(COLOR_NAMES[c] ?? "No colour"),
        maxlength: String(LABEL_MAX),
        autocapitalize: "sentences",
      });
      inputs.push(input);
      return h("label", { class: "cfg-label-row" }, h("span", { class: `cfg-dot cfg-c-${c}`, "aria-hidden": "true" }), h("span", { class: "cfg-label-name" }, t(COLOR_NAMES[c] ?? "No colour")), input);
    }),
    h(
      "div",
      { class: "row-actions" },
      button(t("Reset all"), () => {
        for (const c of COLORS) delete labels[c];
        for (const i of inputs) i.value = "";
      }),
    ),
  );

  renderEditor();
  renderHosts();
  root.replaceChildren(
    h(
      "section",
      { class: "card" },
      h("h2", {}, t("Colour profiles")),
      h(
        "p",
        { class: "hint" },
        t("Colours for the four kinds of chat content, separately for the dark and the light theme. Empty fields keep the theme's colour; values are hex colours such as #2b3a55 or #abc."),
      ),
      editor,
    ),
    hostsCard,
    labelsCard,
    saveBar(async () => {
      const colorProfiles = cleanWebProfiles(draft, fallback);
      await save({ colorProfiles, sessionColorLabels: cleanColorLabels(labels) });
      // host profiles live in the host records; only changed ones are sent
      const ids = new Set(colorProfiles.map((p) => p.id));
      const changed = state.hosts.filter((x) => (hostChoice.get(x.id) ?? "") !== (x.colorProfile ?? ""));
      for (const host of changed) {
        const choice = hostChoice.get(host.id) ?? "";
        try {
          const updated = await hostApi.update(host.id, { colorProfile: ids.has(choice) ? choice : "" });
          state.hosts = state.hosts.map((x) => (x.id === updated.id ? updated : x));
        } catch (e) {
          toast(`${host.name}: ${errMsg(e)}`, "err");
        }
      }
      draft.splice(0, draft.length, ...colorProfiles);
      renderEditor();
      renderHosts();
    }),
  );
}
