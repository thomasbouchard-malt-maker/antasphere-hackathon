// Content script: the on-page guide. Collects clickable elements, shows the
// activation aura, bottom toolbar + animated cursor, handles voice in/out, and runs the
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
      :host { --accent: #e8743b; --accent-soft: rgba(232,116,59,.45); --accent-2: #f5b38a;
        --bar-bg: rgba(24,24,27,.86); --bar-fg: #fafafa; --bar-muted: #a1a1aa; --bar-line: rgba(255,255,255,.12); }
      * { box-sizing: border-box; }
      .ui { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }

      /* --- Activation aura: glowing animated frame around the whole viewport --- */
      .aura { position: fixed; inset: 0; opacity: 0; transition: opacity .5s ease; }
      .ui.active .aura { opacity: 1; }
      .aura .glow { position: absolute; inset: 0;
        box-shadow: inset 0 0 0 2px var(--accent), inset 0 0 28px 6px var(--accent-soft), inset 0 0 90px 10px rgba(232,116,59,.18);
        animation: breathe 3.2s ease-in-out infinite; }
      .aura .edge { position: absolute; inset: 0; padding: 3px;
        background: linear-gradient(90deg, var(--accent), var(--accent-2), #fff6, var(--accent-2), var(--accent)) 0 0 / 300% 100%;
        -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        -webkit-mask-composite: xor; mask-composite: exclude;
        animation: flow 4s linear infinite; }
      /* the entry "sweep": a bright flash that contracts onto the frame */
      .aura .flash { position: absolute; inset: 0; opacity: 0;
        box-shadow: inset 0 0 0 0 transparent, inset 0 0 220px 80px rgba(232,116,59,.35); }
      .ui.entering .aura .flash { animation: flash .9s ease-out; }
      .ui[data-state=listening] .aura .glow { animation-duration: 1.1s; }
      .ui[data-state=thinking] .aura .edge { animation-duration: 1.2s; }
      @keyframes breathe { 50% { opacity: .55; } }
      @keyframes flow { to { background-position: 300% 0; } }
      @keyframes flash { 0% { opacity: 1; transform: scale(.985); } 100% { opacity: 0; transform: scale(1); } }

      /* --- Pointer --- */
      .cursor { position: fixed; left: 0; top: 0; width: 44px; height: 44px; opacity: 0;
        transition: transform .9s cubic-bezier(.22,1,.36,1), opacity .3s; will-change: transform;
        filter: drop-shadow(0 3px 6px rgba(0,0,0,.35)); }
      .cursor.on { opacity: 1; }
      .ring { position: fixed; border: 4px solid var(--accent); border-radius: 10px; opacity: 0;
        box-shadow: 0 0 0 9999px rgba(15,23,42,.18); transition: opacity .3s; }
      .ring.on { opacity: 1; animation: pulse 1.4s ease-in-out infinite; }
      @keyframes pulse { 50% { border-color: var(--accent-2); transform: scale(1.04); } }
      .bubble { position: fixed; max-width: 320px; background: #1e293b; color: #fff; font-size: 18px;
        line-height: 1.4; padding: 12px 16px; border-radius: 14px; opacity: 0; transition: opacity .3s; }
      .bubble.on { opacity: 1; }

      /* --- Bottom-centre dock: caption card + toolbar --- */
      .dock { position: fixed; left: 50%; bottom: 22px; display: flex; flex-direction: column; align-items: center;
        gap: 10px; width: min(640px, calc(100vw - 32px)); pointer-events: none;
        transform: translate(-50%, 24px) scale(.96); opacity: 0;
        transition: transform .45s cubic-bezier(.22,1,.36,1), opacity .3s; }
      .ui.active .dock { transform: translate(-50%, 0) scale(1); opacity: 1; }
      .ui.active .dock > * { pointer-events: auto; }
      .caption { max-width: 100%; background: var(--bar-bg); color: var(--bar-fg); backdrop-filter: blur(14px);
        border: 1px solid var(--bar-line); border-radius: 16px; padding: 12px 16px; font-size: 18px; line-height: 1.4;
        box-shadow: 0 10px 30px rgba(0,0,0,.25); }
      .caption .meta { font-size: 13px; color: var(--bar-muted); margin-top: 4px; }
      .caption .meta:empty { display: none; }
      .caption.error .say { color: #fca5a5; }
      .bar { display: flex; align-items: center; gap: 4px; padding: 6px; border-radius: 999px;
        background: var(--bar-bg); color: var(--bar-fg); backdrop-filter: blur(14px);
        border: 1px solid var(--bar-line); box-shadow: 0 12px 36px rgba(0,0,0,.3), 0 0 0 1px rgba(232,116,59,.25); }
      .bar button { all: unset; display: inline-flex; align-items: center; gap: 6px; height: 40px; padding: 0 12px;
        border-radius: 999px; font: 500 14px system-ui, sans-serif; color: var(--bar-fg); cursor: pointer; white-space: nowrap; }
      .bar button:hover { background: rgba(255,255,255,.1); }
      .bar button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      .bar .mic { width: 40px; padding: 0; justify-content: center; background: var(--accent); font-size: 18px; }
      .bar .mic:hover { background: var(--accent); filter: brightness(1.1); }
      .bar .mic.listening { background: #dc2626; animation: pulse-bg 1s infinite; }
      @keyframes pulse-bg { 50% { box-shadow: 0 0 0 6px rgba(220,38,38,.3); } }
      .bar .text { all: unset; width: 200px; height: 40px; padding: 0 12px; border-radius: 999px;
        background: rgba(255,255,255,.08); font: 14px system-ui, sans-serif; color: var(--bar-fg); }
      .bar .text::placeholder { color: var(--bar-muted); }
      .bar .sep { width: 1px; height: 22px; background: var(--bar-line); margin: 0 4px; }
      .bar .close { width: 40px; padding: 0; justify-content: center; color: var(--bar-muted); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); margin: 0 6px 0 8px;
        animation: breathe 1.6s infinite; }
      @media (max-width: 560px) { .bar .label { display: none; } .bar .text { width: 120px; } }
      @media (prefers-reduced-motion: reduce) { *, .aura .glow, .aura .edge { animation: none !important; transition: none !important; } }
    </style>
    <div class="ui" data-state="idle">
      <div class="aura"><div class="glow"></div><div class="edge"></div><div class="flash"></div></div>
      <svg class="cursor" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#e8743b" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>
      <div class="ring"></div>
      <div class="bubble"></div>
      <div class="dock" role="toolbar" aria-label="Guide">
        <div class="caption" aria-live="polite">
          <div class="say">Hi! Press the microphone and tell me what you want to do.</div>
          <div class="meta"></div>
        </div>
        <div class="bar">
          <span class="dot" title="Guide is active"></span>
          <button class="mic" title="Talk (Alt+G)" aria-label="Talk">🎤</button>
          <input class="text" placeholder="Or type: how do I…" aria-label="Ask the guide" />
          <span class="sep"></span>
          <button data-cmd="repeat" title="Repeat">🔁<span class="label">Repeat</span></button>
          <button data-cmd="next" title="Next step">⏭<span class="label">Next</span></button>
          <button data-cmd="stop" title="Stop this task">⏹<span class="label">Stop</span></button>
          <span class="sep"></span>
          <button class="close" title="Close the guide (Esc)" aria-label="Close">✕</button>
        </div>
      </div>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const ui = $(".ui"), cursor = $(".cursor"), ring = $(".ring"), bubble = $(".bubble");
  const caption = $(".caption"), sayEl = $(".say"), metaEl = $(".meta"), micBtn = $(".mic"), textIn = $(".text");

  // ---------- Activation ----------

  let active = false;

  function activate() {
    if (active) return;
    active = true;
    ui.classList.add("active", "entering");
    setTimeout(() => ui.classList.remove("entering"), 900);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    command("stop");
    ui.classList.remove("active");
  }

  const setState = (state) => { ui.dataset.state = state; };

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
    recognition.onend = () => { recognition = null; micBtn.classList.remove("listening"); setState("idle"); };
    micBtn.classList.add("listening");
    setState("listening");
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
    caption.classList.toggle("error", isError);
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
    activate();
    setState("thinking");
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
      setState("idle");
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
    if (e.altKey && e.code === "KeyG") { activate(); listen(); }
    if (e.key === "Escape" && active) deactivate();
  });
  $(".close").addEventListener("click", deactivate);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "toggle") (active ? deactivate() : activate());
  });

  // Resume a guided task after a full page navigation
  send("getState")
    .then((state) => {
      if (!state.active) return;
      activate();
      lastStep = state.lastStep;
      if (state.pending) setTimeout(() => ask("[clicked target]"), SETTLE_MS);
      else if (lastStep) setSay(lastStep.say);
    })
    .catch(() => {});
})();
