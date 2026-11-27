import { mountOrb } from "./orb.js";
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
mountOrb($("orb"));

const showChoices = (message) => {
  $("waiting").hidden = true;
  $("choices").hidden = false;
  $("error").hidden = !message;
  $("error").textContent = message || "";
};
const showWaiting = () => {
  $("choices").hidden = true;
  $("waiting").hidden = false;
  $("waiting-title").textContent = "Finish signing in in your browser";
  $("waiting-detail").textContent = "We'll bring you back here as soon as you're done.";
  $("waiting-actions").hidden = false;
};
const start = (intent) => invoke("begin_sign_in", { intent }).then(showWaiting, (message) => showChoices(String(message)));

$("sign-up").addEventListener("click", () => start("sign-up"));
$("sign-in").addEventListener("click", () => start("sign-in"));
$("embedded").addEventListener("click", () => invoke("use_embedded_sign_in"));
$("reopen").addEventListener("click", () => invoke("reopen_browser"));
$("cancel").addEventListener("click", () => invoke("cancel_sign_in").then(() => showChoices()));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("waiting").hidden) $("cancel").click();
});

listen("sign-in-failed", (event) => showChoices(event.payload));
listen("sign-in-finishing", () => {
  $("waiting-title").textContent = "Signing you in…";
  $("waiting-detail").textContent = "This only takes a moment.";
  $("waiting-actions").hidden = true;
});
