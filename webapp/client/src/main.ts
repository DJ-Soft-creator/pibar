// Entry of the webapp client. Placeholder until the app shell (task C2): shows that the build works, shared code
// from src/shared/ is usable and the bridge reaches the server's command router.
import { cleanTitle } from "@shared/format";
import { applyTheme } from "@shared/theme";
import { invoke } from "./bridge";

applyTheme("auto");

const root = document.getElementById("app");
if (root) {
  root.textContent = cleanTitle("PiBar Webapp – im Umbau");
  invoke<{ username: string }>("ping")
    .then((r) => root.append(document.createElement("br"), `Angemeldet als ${r.username}`))
    .catch((e: unknown) => root.append(document.createElement("br"), `Server: ${String(e)}`));
}
