import { useState, useEffect, useRef, useCallback } from "react";
import "./OperatorCopilot.css";

const NLP_URL =
  import.meta.env.VITE_NLP_URL !== undefined && import.meta.env.VITE_NLP_URL !== ""
    ? import.meta.env.VITE_NLP_URL
    : typeof window !== "undefined" && window.location.hostname !== "localhost"
    ? "/nlp"
    : "http://localhost:8100";

const SUGGESTIONS = [
  "which cells are above 40 degrees?",
  "why is cell 7 hot?",
  "any anomalies right now?",
  "what if reynolds number is 600",
  "replaced thermal pad on cell 3 after voltage sag",
];

const NARRATE_EVERY_MS = 3000;

/** Split `text` into plain / entity segments using the CRF's character spans. */
function segments(text, entities) {
  const out = [];
  let cur = 0;
  [...entities]
    .sort((a, b) => a.start - b.start)
    .forEach((e) => {
      if (e.start > cur) out.push({ t: text.slice(cur, e.start) });
      out.push({ t: text.slice(e.start, e.end), e });
      cur = e.end;
    });
  if (cur < text.length) out.push({ t: text.slice(cur) });
  return out;
}

function fmtValue(e) {
  const v = e.value;
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.length ? `→ ${v.join(", ")}` : "";
  return typeof v === "string" ? `→ ${v}` : `→ ${v}`;
}

function UserBubble({ parse }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="oc-msg oc-user">
      <div className="oc-bubble">
        <div className="oc-text">
          {segments(parse.text, parse.entities).map((s, i) =>
            s.e ? (
              <span key={i} className={`oc-ent oc-ent-${s.e.label}`} title={`${s.e.label} ${fmtValue(s.e)} (${s.e.confidence ?? ""})`}>
                {s.t}
                <sup>{s.e.label}</sup>
              </span>
            ) : (
              <span key={i}>{s.t}</span>
            )
          )}
        </div>
        <div className="oc-meta">
          <span className="oc-intent">{parse.intent}</span>
          <span className="oc-conf">{Math.round(parse.intent_confidence * 100)}%</span>
          <button className="oc-link" onClick={() => setOpen((v) => !v)}>
            {open ? "hide" : "how I understood this"}
          </button>
        </div>
        {open && (
          <div className="oc-trace">
            <div className="oc-trace-row">
              {parse.tokens.map((t, i) => (
                <div key={i} className="oc-tok">
                  <span className="oc-tok-w">{t.text}</span>
                  <span className="oc-tok-pos">{t.pos}</span>
                  <span className="oc-tok-chunk">{t.chunk}</span>
                  <span className={`oc-tok-tag ${t.tag === "O" ? "" : "on"}`}>{t.tag}</span>
                </div>
              ))}
            </div>
            <div className="oc-trace-note">
              word · POS · chunk · CRF tag &nbsp;|&nbsp; intent input: <code>{parse.abstract}</code>
            </div>
            {parse.entities.length > 0 && (
              <ul className="oc-ents">
                {parse.entities.map((e, i) => (
                  <li key={i}>
                    <span className={`oc-ent oc-ent-${e.label}`}>{e.text}</span> {e.label} {fmtValue(e)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function BotBubble({ msg, cells, onSelectCell }) {
  return (
    <div className="oc-msg oc-bot">
      <div className="oc-bubble">
        <div className="oc-text oc-reply">{msg.reply}</div>
        {msg.highlight_cells?.length > 0 && (
          <div className="oc-chips">
            {msg.highlight_cells.map((id) => (
              <button
                key={id}
                className="oc-chip"
                onClick={() => {
                  const c = cells?.find((x) => x.cell_id === id);
                  if (c && onSelectCell) onSelectCell(c);
                }}
              >
                C{String(id + 1).padStart(2, "0")}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function OperatorCopilot({ cells, onSelectCell }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(null);
  const [narr, setNarr] = useState(null);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, busy]);

  // Live LSTM narrative
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch(`${NLP_URL}/narrate`);
        const j = await r.json();
        if (!alive) return;
        setOnline(true);
        if (j.status === "ok") setNarr(j.narrative);
      } catch {
        if (alive) setOnline(false);
      }
    }
    load();
    const id = setInterval(load, NARRATE_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const send = useCallback(
    async (text) => {
      const q = text.trim();
      if (!q || busy) return;
      setInput("");
      setBusy(true);
      try {
        const r = await fetch(`${NLP_URL}/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: q }),
        });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        setMessages((m) => [...m, { role: "user", parse: j.parse }, { role: "bot", ...j }]);
        setOnline(true);
      } catch {
        setOnline(false);
        setMessages((m) => [
          ...m,
          { role: "bot", reply: "NLP service unreachable. Start it with: python -m uvicorn nlp_service.main:app --port 8100" },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy]
  );

  return (
    <aside className="oc-card" aria-label="Operator copilot">
      <div className="oc-head">
        <div>
          <span className="oc-title">OPERATOR COPILOT</span>
          <span className="oc-sub">CRF NER · MaxEnt intent · LSTM seq2seq</span>
        </div>
        <span className={`oc-dot ${online ? "on" : online === false ? "off" : ""}`} title={online ? "NLP service online" : "NLP service offline"} />
      </div>

      <div className={`oc-narr ${narr?.severity || ""}`}>
        <span className="oc-narr-label">LIVE NARRATIVE · LSTM{narr ? ` · tick ${narr.tick}` : ""}</span>
        <p>{narr ? narr.text : "Waiting for telemetry…"}</p>
      </div>

      <div className="oc-log" role="log" aria-live="polite">
        {messages.length === 0 && (
          <div className="oc-empty">Ask in plain English — or file a fault note. Try a suggestion below.</div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <UserBubble key={i} parse={m.parse} />
          ) : (
            <BotBubble key={i} msg={m} cells={cells} onSelectCell={onSelectCell} />
          )
        )}
        {busy && <div className="oc-typing">analysing…</div>}
        <div ref={endRef} />
      </div>

      <div className="oc-suggest">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="oc-sg" onClick={() => send(s)}>
            {s}
          </button>
        ))}
      </div>

      <form
        className="oc-form"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          id="copilot-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. which cells are above forty degrees?"
          autoComplete="off"
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Ask
        </button>
      </form>
    </aside>
  );
}
