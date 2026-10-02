import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

const PORT = Number(process.env.PORT ?? 8787);
const DOCS_DIR = path.resolve(process.env.DOCS_DIR ?? "../docs");
const MOCK = process.env.MOCK === "1";
const MODEL = "claude-opus-5-5";

// ---------- Types shared with the extension ----------

interface PageElement {
  id: number; // value of data-guide-id on the page
  role: string; // button, link, input, select, menuitem...
  label: string;
  inViewport: boolean;
}

interface GuideRequest {
  sessionId?: string;
  // What the user said, or a system event like "[clicked target]"
  utterance: string;
  url: string;
  title: string;
  elements: PageElement[];
  screenshot?: string; // data URL (jpeg)
}

interface GuideStep {
  say: string;
  target_id: number; // -1 when there is nothing to point at
  action: "click" | "type" | "select" | "look" | "none";
  step: number;
  total_steps: number;
  status: "in_progress" | "task_complete" | "need_info";
}

// ---------- Docs the guide has "absorbed" ----------

function loadDocs(): string {
  if (!fs.existsSync(DOCS_DIR)) return "(no documentation loaded)";
  // Sorted so the cached prefix is byte-identical across restarts
  const files = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => /\.(md|txt)$/i.test(f) && f.toLowerCase() !== "readme.md")
    .sort();
  return files
    .map((f) => `<doc name="${f}">\n${fs.readFileSync(path.join(DOCS_DIR, f), "utf8")}\n</doc>`)
    .join("\n\n");
}

const DOCS = loadDocs();

const INSTRUCTIONS = `You are a patient, friendly guide that helps people use business software (ERP, CRM, accounting tools) by pointing at things on their screen and talking them through it, one step at a time.

Your users are often older people or busy business owners who have never read the manual. Your answer is read aloud, so:
- Speak in the user's language. One or two short sentences per step. No lists, no markdown, no jargon.
- Name the thing to click the way it looks on screen ("the blue New button at the top left").
- Never do the action for them. You point; they click.
- Be encouraging, never condescending.

Each turn you receive the current page: its URL, a screenshot, and a numbered list of interactive elements ([id] role "label"). Rely on the documentation below for the correct procedure in this software. If the documentation and the screen disagree, trust the screen.

Pick exactly ONE next step and set:
- target_id: the id of the element to point at, or -1 if nothing on screen fits (then tell them where to look or to scroll).
- action: what they should do with it (click, type, select, look) or none.
- step / total_steps: where they are in the whole task (your best estimate; total_steps can change).
- status: in_progress, task_complete when the goal is reached (congratulate them briefly), or need_info when you must ask a question first (e.g. "which customer?").

When the message is "[clicked target]" or "[changed target]", the user just did the previous step: check the new screen and give the next step. If the screen shows the previous step did not work, gently help them fix it. "[next]" means they want to move on; "[repeat]" means say the current step again more simply.`;

const SYSTEM: Anthropic.Beta.BetaTextBlockParam[] = [
  { type: "text", text: INSTRUCTIONS },
  // Docs are the big, stable part: cache them (1h so a demo session stays warm)
  {
    type: "text",
    text: `<documentation>\n${DOCS}\n</documentation>`,
    cache_control: { type: "ephemeral", ttl: "1h" },
  },
];

const STEP_SCHEMA = {
  type: "object",
  properties: {
    say: { type: "string" },
    target_id: { type: "integer" },
    action: { type: "string", enum: ["click", "type", "select", "look", "none"] },
    step: { type: "integer" },
    total_steps: { type: "integer" },
    status: { type: "string", enum: ["in_progress", "task_complete", "need_info"] },
  },
  required: ["say", "target_id", "action", "step", "total_steps", "status"],
  additionalProperties: false,
};

// ---------- Conversation state (in memory; fine for a hackathon) ----------

const sessions = new Map<string, Anthropic.Beta.BetaMessageParam[]>();
const client = MOCK ? null : new Anthropic();

function describePage(req: GuideRequest): string {
  const list = req.elements
    .map((e) => `[${e.id}] ${e.role} "${e.label}"${e.inViewport ? "" : " (off-screen)"}`)
    .join("\n");
  return `User: ${req.utterance}\n\nPage: ${req.title}\nURL: ${req.url}\n\nInteractive elements:\n${list || "(none found)"}`;
}

async function guide(req: GuideRequest): Promise<GuideStep & { sessionId: string }> {
  const sessionId = req.sessionId && sessions.has(req.sessionId) ? req.sessionId : randomUUID();
  const history = sessions.get(sessionId) ?? [];

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (req.screenshot) {
    const data = req.screenshot.replace(/^data:image\/\w+;base64,/, "");
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
  }
  content.push({ type: "text", text: describePage(req) });
  history.push({ role: "user", content });

  if (MOCK) {
    const target = req.elements.find((e) => e.inViewport && e.role === "button") ?? req.elements[0];
    const step: GuideStep = {
      say: target ? `Mock mode: click "${target.label}".` : "Mock mode: nothing to click here.",
      target_id: target?.id ?? -1,
      action: target ? "click" : "none",
      step: 1,
      total_steps: 1,
      status: "in_progress",
    };
    console.log(`[mock ${sessionId.slice(0, 8)}] "${req.utterance}" -> target ${step.target_id}`);
    history.push({ role: "assistant", content: JSON.stringify(step) });
    sessions.set(sessionId, history);
    return { ...step, sessionId };
  }

  const response = await client!.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    // Auto-cache the growing conversation too
    cache_control: { type: "ephemeral" },
    // Voice UX: keep turns snappy
    output_config: { effort: "low", format: { type: "json_schema", schema: STEP_SCHEMA } },
    // If a safety classifier declines, retry server-side on Anthropic's recommended model
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: history,
  });

  if (response.stop_reason === "refusal") {
    history.pop();
    throw new Error("The model declined this request.");
  }

  // Append-only history: pass the assistant content back unchanged
  history.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
  sessions.set(sessionId, history);

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error(`No text in response (stop_reason=${response.stop_reason})`);
  const step = JSON.parse(text.text) as GuideStep;

  const u = response.usage;
  console.log(
    `[${sessionId.slice(0, 8)}] step ${step.step}/${step.total_steps} target=${step.target_id} ` +
      `in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0}`,
  );
  return { ...step, sessionId };
}

// ---------- HTTP ----------

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, mock: MOCK });

  if (req.method === "POST" && req.url === "/api/guide") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const body = JSON.parse(raw) as GuideRequest;
      send(res, 200, await guide(body));
    } catch (err) {
      console.error(err);
      if (err instanceof Anthropic.APIError) return send(res, 502, { error: `Claude API ${err.status}: ${err.message}` });
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/reset") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { sessionId } = JSON.parse(raw || "{}");
    if (sessionId) sessions.delete(sessionId);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Guide server on http://localhost:${PORT}${MOCK ? " (MOCK mode, no Claude calls)" : ""}`);
  console.log(`Docs loaded from ${DOCS_DIR}: ${DOCS.length.toLocaleString()} chars`);
});
