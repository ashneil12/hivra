import { mountOrb } from "./orb.js";
mountOrb(document.getElementById("orb"));
window.__TAURI__.core.invoke("open_hivra").catch(() => {
  document.getElementById("status").textContent = "Couldn't reach Hivra. Check your connection.";
});
