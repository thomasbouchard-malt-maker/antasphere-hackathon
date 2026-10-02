// Content script: the on-page guide. Collects clickable elements, shows the
// floating panel + animated cursor, handles voice in/out, and runs the
// "point -> wait for the user's click -> next step" loop.

(() => {
  if (window.__guideLoaded) return;
  window.__guideLoaded = true;

  const LANG = navigator.language || "en-US";
  const SETTLE_MS = 900; // wait for the app to update after a click

  // ---------- Element map ----------

  const SELECTOR = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=menuitem]", "[role=tab]", "[role=option]",
    "[role=checkbox]", "[role=radio]", "[role=combobox]", "[role=switch]",
    "[contenteditable=true]", "[onclick]",
  ].join(",");
  const MAX_ELEMENTS = 300;
  let elementsById = new Map();

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 80);

  function labelFor(el) {
    const byIds = el.getAttribute("aria-labelledby");
    const labelledBy = byIds
      ? byIds.split(/\s+/).map((id) => document.getElementById(id)?.innerText).join(" ")
      : "";
    return clean(
      el.getAttribute("aria-label") ||
        labelledBy ||
        el.labels?.[0]?.innerText ||
        el.getAttribute("placeholder") ||
        el.innerText ||
        el.getAttribute("title") ||
        el.querySelector?.("img[alt]")?.getAttribute("alt") ||
        (el.tagName === "INPUT" && ["submit", "button"].includes(el.type) ? el.value : "") ||
        el.getAttribute("name") ||
        "",
    );
  }

  function roleFor(el) {
    const role = el.getAttribute("role");
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "input") return `input:${el.type || "text"}`;
    return tag;
  }

  function collectElements() {
    elementsById = new Map();
    const vw = window.innerWidth, vh = window.innerHeight;
    const found = [];
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (host.contains(el)) continue;
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const label = labelFor(el);
      if (!label && !el.matches("input,select,textarea")) continue;
      const inViewport = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
      found.push({ el, role: roleFor(el), label, inViewport });
    }
    // On-screen first, then cap
    found.sort((a, b) => Number(b.inViewport) - Number(a.inViewport));
    return found.slice(0, MAX_ELEMENTS).map((item, i) => {
      const id = i + 1;
      elementsById.set(id, item.el);
      return { id, role: item.role, label: item.label, inViewport: item.inViewport };
    });
  }

  // ---------- UI (shadow DOM so the host page's CSS can't break it) ----------

  const host = document.createElement("div");
  host.id = "guide-extension-root";
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .bubble, .panel, .panel button, .panel input { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .cursor { position: fixed; left: 0; top: 0; width: 44px; height: 44px; opacity: 0;
        transition: transform .9s cubic-bezier(.22,1,.36,1), opacity .3s; will-change: transform;
        filter: drop-shadow(0 3px 6px rgba(0,0,0,.35)); }
      .cursor.on { opacity: 1; }
      .ring { position: fixed; border: 4px solid #2563eb; border-radius: 10px; opacity: 0;
        box-shadow: 0 0 0 9999px rgba(15,23,42,.18); transition: opacity .3s; }
      .ring.on { opacity: 1; animation: pulse 1.4s ease-in-out infinite; }
      @keyframes pulse { 50% { border-color: #60a5fa; transform: scale(1.04); } }
      .bubble { position: fixed; max-width: 320px; background: #1e293b; color: #fff; font-size: 18px;
        line-height: 1.4; padding: 12px 16px; border-radius: 14px; opacity: 0; transition: opacity .3s; }
      .bubble.on { opacity: 1; }
      .panel { position: fixed; right: 20px; bottom: 20px; width: 340px; pointer-events: auto;
        background: #fff; color: #0f172a; border-radius: 18px; padding: 16px;
        box-shadow: 0 10px 40px rgba(0,0,0,.25); font-size: 18px; }
      .panel.hidden { display: none; }
      .row { display: flex; gap: 8px; align-items: center; }
      .mic { width: 64px; height: 64px; border-radius: 50%; border: 0; background: #2563eb; color: #fff;
        font-size: 28px; cursor: pointer; flex: none; }
      .mic.listening { background: #dc2626; animation: pulse 1s infinite; }
      .text { flex: 1; font-size: 16px; padding: 10px; border: 2px solid #cbd5e1; border-radius: 10px; min-width: 0; }
      .say { margin: 12px 0 8px; min-height: 2.8em; font-size: 20px; line-height: 1.35; }
      .meta { font-size: 14px; color: #64748b; }
      .btns { display: flex; gap: 6px; margin-top: 10px; }
      .btns button { flex: 1; font-size: 16px; padding: 10px; border-radius: 10px; border: 2px solid #cbd5e1;
        background: #f8fafc; cursor: pointer; }
      .error { color: #b91c1c; }
    </style>
    <svg class="cursor" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#2563eb" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>
    <div class="ring"></div>
    <div class="bubble"></div>
    <div class="panel hidden">
      <div class="row">
        <button class="mic" title="Hold a conversation">🎤</button>
        <input class="text" placeholder="Or type: how do I…" />
      </div>
      <div class="say">Hi! Press the microphone and tell me what you want to do.</div>
      <div class="meta"></div>
      <div class="btns">
        <button data-cmd="repeat">🔁 Repeat</button>
        <button data-cmd="next">⏭ Next</button>
        <button data-cmd="stop">⏹ Stop</button>
      </div>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const cursor = $(".cursor"), ring = $(".ring"), bubble = $(".bubble"), panel = $(".panel");
  const sayEl = $(".say"), metaEl = $(".meta"), micBtn = $(".mic"), textIn = $(".text");

  // ---------- Pointing ----------

  let target = null;
  let trackFrame = 0;

  function trackTarget() {
    cancelAnimationFrame(trackFrame);
    if (!target || !target.isConnected) return;
    const r = target.getBoundingClientRect();
    const pad = 6;
    Object.assign(ring.style, {
      left: `${r.left - pad}px`, top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    });
    // Cursor tip lands just below-right of the element's center
    cursor.style.transform = `translate(${r.left + r.width / 2}px, ${r.top + r.height / 2}px)`;
    const bx = Math.min(r.left, window.innerWidth - 340);
    const by = r.bottom + 54 < window.innerHeight - 80 ? r.bottom + 54 : Math.max(10, r.top - 110);
    Object.assign(bubble.style, { left: `${Math.max(10, bx)}px`, top: `${by}px` });
    trackFrame = requestAnimationFrame(trackTarget);
  }

  function pointAt(el, text) {
    target = el;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: "center", behavior: "smooth" });
    bubble.textContent = text;
    [cursor, ring, bubble].forEach((n) => n.classList.add("on"));
    trackTarget();
  }

  function clearPointer() {
    target = null;
    cancelAnimationFrame(trackFrame);
    [ring, bubble].forEach((n) => n.classList.remove("on"));
  }

  // ---------- Voice ----------

  function speak(text) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LANG;
    u.rate = 0.95; // a little slower: easier to follow
    speechSynthesis.speak(u);
  }

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;

  function listen() {
    if (!Recognition) {
      setSay("Voice input isn't available in this browser. Please type instead.", true);
      return;
    }
    if (recognition) return recognition.stop();
    speechSynthesis.cancel();
    recognition = new Recognition();
    recognition.lang = LANG;
    recognition.interimResults = false;
    recognition.onresult = (e) => handleUtterance(e.results[0][0].transcript);
    recognition.onerror = (e) => setSay(`Microphone: ${e.error}`, true);
    recognition.onend = () => { recognition = null; micBtn.classList.remove("listening"); };
    micBtn.classList.add("listening");
    recognition.start();
  }

  const VOICE_COMMANDS = [
    [/^(repeat|again|répète|repete|encore)\b/i, "repeat"],
    [/^(next|skip|suivant|continue|continuer)\b/i, "next"],
    [/^(stop|cancel|arrête|arrete|annule)\b/i, "stop"],
  ];

  function handleUtterance(said) {
    const text = said.trim();
    if (!text) return;
    const cmd = VOICE_COMMANDS.find(([re]) => re.test(text));
    if (cmd) return command(cmd[1]);
    ask(text);
  }

  // ---------- Step loop ----------

  let busy = false;
  let disarm = () => {};
  let lastStep = null;

  function setSay(text, isError = false) {
    sayEl.textContent = text;
    sayEl.classList.toggle("error", isError);
  }

  async function send(type, payload) {
    const res = await chrome.runtime.sendMessage({ type, payload });
    if (!res?.ok) throw new Error(res?.error || "Extension error");
    return res.result;
  }

  async function ask(utterance) {
    if (busy) return;
    busy = true;
    disarm();
    panel.classList.remove("hidden");
    metaEl.textContent = "Looking at your screen…";
    try {
      const elements = collectElements();
      const step = await send("guide", { utterance, url: location.href, title: document.title, elements });
      showStep(step);
    } catch (err) {
      setSay(`Sorry, something went wrong: ${err.message}`, true);
      metaEl.textContent = "";
    } finally {
      busy = false;
    }
  }

  function showStep(step) {
    lastStep = step;
    setSay(step.say);
    speak(step.say);
    metaEl.textContent =
      step.status === "task_complete" ? "✅ Done!" : step.total_steps > 1 ? `Step ${step.step} of ${step.total_steps}` : "";

    const el = elementsById.get(step.target_id);
    if (el && step.status !== "task_complete") {
      pointAt(el, step.say);
      armWaitFor(el, step.action);
    } else {
      clearPointer();
      if (step.status === "task_complete") setTimeout(() => cursor.classList.remove("on"), 4000);
    }
  }

  // Wait for the user to do the step themselves, then ask for the next one
  function armWaitFor(el, action) {
    disarm();
    const isField = action === "type" || action === "select";
    const continueWith = (event) => {
      disarm();
      send("markPending").catch(() => {}); // in case this click navigates away
      setTimeout(() => ask(event), SETTLE_MS);
    };
    const onClick = (e) => {
      if (host.contains(e.target)) return;
      if (el.contains(e.target) || e.target.contains?.(el)) continueWith("[clicked target]");
    };
    const onChange = (e) => {
      if (el.contains(e.target)) continueWith("[changed target]");
    };
    document.addEventListener("click", onClick, true);
    if (isField) document.addEventListener("change", onChange, true);
    disarm = () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("change", onChange, true);
      disarm = () => {};
    };
  }

  async function command(cmd) {
    if (cmd === "stop") {
      disarm();
      clearPointer();
      cursor.classList.remove("on");
      speechSynthesis.cancel();
      setSay("Okay, stopped. Press the microphone whenever you need me.");
      metaEl.textContent = "";
      lastStep = null;
      await send("reset").catch(() => {});
    } else if (cmd === "repeat") {
      if (lastStep) speak(lastStep.say);
    } else if (cmd === "next") {
      ask("[next]");
    }
  }

  // ---------- Wiring ----------

  micBtn.addEventListener("click", listen);
  textIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && textIn.value.trim()) {
      handleUtterance(textIn.value);
      textIn.value = "";
    }
  });
  root.querySelectorAll("[data-cmd]").forEach((b) => b.addEventListener("click", () => command(b.dataset.cmd)));
  window.addEventListener("keydown", (e) => {
    // Alt+G: push to talk from anywhere on the page
    if (e.altKey && e.code === "KeyG") { panel.classList.remove("hidden"); listen(); }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "toggle") panel.classList.toggle("hidden");
  });

  // Resume a guided task after a full page navigation
  send("getState")
    .then((state) => {
      if (!state.active) return;
      panel.classList.remove("hidden");
      lastStep = state.lastStep;
      if (state.pending) setTimeout(() => ask("[clicked target]"), SETTLE_MS);
      else if (lastStep) setSay(lastStep.say);
    })
    .catch(() => {});
})();
