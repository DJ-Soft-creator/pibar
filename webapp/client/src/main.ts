// Entry of the webapp client. Placeholder until the app shell (task C2): shows that the build works, shared
// code from src/shared/ is usable and the server answers.
import { cleanTitle } from "@shared/format";
import { applyTheme } from "@shared/theme";

applyTheme("auto");

const root = document.getElementById("app");
if (root) {
  root.textContent = cleanTitle("PiBar Webapp – im Umbau");
  fetch("/api/health")
    .then((r) => r.json())
    .then((d: { status?: string }) => {
      root.append(document.createElement("br"), `Server: ${d.status ?? "?"}`);
    })
    .catch(() => root.append(document.createElement("br"), "Server: nicht erreichbar"));
}
