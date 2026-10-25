import { useState, useEffect, useCallback, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import CellGrid from "../components/CellGrid";
import RecommendationsPanel from "../components/RecommendationsPanel";
import PackTrendChart from "../components/PackTrendChart";
import ProfilePanel from "../components/ProfilePanel";
import ExportButton from "../components/ExportButton";
import ServiceHealthMonitor from "../components/ServiceHealthMonitor";
import OperatorCopilot from "../components/OperatorCopilot";
import EventTimeline, { createEvent } from "../components/EventTimeline";
import CellDetailModal from "../components/CellDetailModal";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../components/ToastNotification";

const AI_ENGINE_URL =
  import.meta.env.VITE_AI_ENGINE_URL !== undefined &&
  import.meta.env.VITE_AI_ENGINE_URL !== ""
    ? import.meta.env.VITE_AI_ENGINE_URL
    : typeof window !== "undefined" && window.location.hostname !== "localhost"
    ? "/api"
    : "http://localhost:8000";

const POLL_INTERVAL_MS = 1000;
const HISTORY_LENGTH = 60;
const MAX_EVENTS = 200;

function makePlaceholderCells() {
  return Array.from({ length: 10 }, (_, i) => ({
    cell_id: i,
    voltage: 3.6,
    current: 2.5,
    temperature: 25 + i * 0.5,
    soc: 95,
    is_spike: false,
    temperature_norm: (25 + i * 0.5) / 60,
  }));
}

function getThermalStatus(recommendation) {
  if (!recommendation) return "ok";
  return recommendation.severity === "critical"
    ? "critical"
    : recommendation.severity === "warning"
    ? "warning"
    : "ok";
}

function StatCard({ label, value, unit, valueClass, id, sub }) {
  return (
    <div className="stat-card" id={id}>
      <span className="stat-label">{label}</span>
      <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
        <span className={`stat-value ${valueClass}`}>{value}</span>
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export default function DashboardPage() {
  const { user, isAuthenticated, logout } = useAuth();
  const navigate = useNavigate();
  const { addToast } = useToast();

  const [cells, setCells] = useState(makePlaceholderCells);
  const [recommendation, setRecommendation] = useState(null);
  const [tick, setTick] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [startTime] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [selectedCell, setSelectedCell] = useState(null);
  // Keep a ref in sync so fetchData can read current value without being a dep
  const _setSelectedCell = (val) => {
    selectedCellRef.current = val;
    setSelectedCell(val);
  };
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [events, setEvents] = useState([]);

  const historyRef = useRef([]);
  const [history, setHistory] = useState([]);
  const cellHistoryRef = useRef(new Map());
  const [cellHistory, setCellHistory] = useState(new Map());
  const eventLogRef = useRef(null);
  const selectedCellRef = useRef(null);

  // Tracking refs for toast/event deduplication
  const prevConnected = useRef(null);
  const prevSpikeCount = useRef(0);
  const prevDeltaOk = useRef(true);

  const pushEvent = useCallback((type, message, meta = null) => {
    const evt = createEvent(type, message, meta);
    setEvents((prev) => [evt, ...prev].slice(0, MAX_EVENTS));
  }, []);

  // Elapsed timer
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startTime]);

  // Fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKey(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "p" || e.key === "P") setProfileOpen((v) => !v);
      if (e.key === "f" || e.key === "F") toggleFullscreen();
      if (e.key === "Escape") { setSelectedCell(null); setProfileOpen(false); }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [toggleFullscreen]);

  const fetchData = useCallback(async () => {
    try {
      const [telemetryRes, recRes] = await Promise.all([
        fetch(`${AI_ENGINE_URL}/telemetry/latest`),
        fetch(`${AI_ENGINE_URL}/recommendations`),
      ]);
      if (!telemetryRes.ok || !recRes.ok) throw new Error("API error");

      const telemetryData = await telemetryRes.json();
      const recData = await recRes.json();

      if (telemetryData.status === "ok" && telemetryData.telemetry?.cells) {
        const newCells = telemetryData.telemetry.cells;
        const newTick = telemetryData.telemetry.tick;
        setCells(newCells);
        setTick(newTick);

        // Pack history
        const temps = newCells.map((c) => c.temperature);
        const avgT = temps.reduce((a, b) => a + b, 0) / temps.length;
        const maxT = Math.max(...temps);
        const minT = Math.min(...temps);
        historyRef.current = [
          ...historyRef.current.slice(-(HISTORY_LENGTH - 1)),
          { tick: newTick, avgTemp: avgT, maxTemp: maxT, minTemp: minT },
        ];
        setHistory([...historyRef.current]);

        // Cell sparklines
        const map = new Map(cellHistoryRef.current);
        newCells.forEach((c) => {
          const prev = map.get(c.cell_id) || [];
          map.set(c.cell_id, [...prev.slice(-14), c.temperature]);
        });
        cellHistoryRef.current = map;
        setCellHistory(new Map(map));

        // Update selected cell if modal open (read from ref — no dep needed)
        if (selectedCellRef.current !== null) {
          const updated = newCells.find((c) => c.cell_id === selectedCellRef.current.cell_id);
          if (updated) setSelectedCell(updated);
        }

        // Toast + event log: spikes
        const spikes = newCells.filter((c) => c.is_spike);
        if (spikes.length > 0 && spikes.length !== prevSpikeCount.current) {
          const ids = spikes.map((c) => `C${String(c.cell_id + 1).padStart(2, "0")}`).join(", ");
          addToast({ type: "critical", title: "Thermal Spike", message: `${spikes.length} cell(s): ${ids}`, duration: 5000 });
          pushEvent("spike", `Thermal spike — ${spikes.length} cell(s) exceeded 45°C`, `Cells: ${ids} · Tick #${newTick}`);
        }
        prevSpikeCount.current = spikes.length;

        // Toast + event: ΔT
        const dt = maxT - minT;
        const dtOk = dt <= 5;
        if (!dtOk && prevDeltaOk.current) {
          addToast({ type: "warning", title: "ΔT Exceeds Target", message: `Pack ΔT is ${dt.toFixed(1)}°C (target <5°C)`, duration: 4000 });
          pushEvent("delta_warn", `Pack ΔT exceeded 5°C threshold`, `ΔT = ${dt.toFixed(2)}°C · Tick #${newTick}`);
        }
        if (dtOk && !prevDeltaOk.current) {
          pushEvent("delta_ok", "Pack ΔT returned within 5°C target", `ΔT = ${dt.toFixed(2)}°C`);
        }
        prevDeltaOk.current = dtOk;

        setConnected(true);
        setError(null);

        if (prevConnected.current === false) {
          addToast({ type: "success", title: "Telemetry Restored", message: "Live data stream reconnected" });
          pushEvent("online", "Telemetry stream reconnected", `AI Engine → ${AI_ENGINE_URL}`);
        }
        prevConnected.current = true;
      }

      if (recData.status === "ok" && recData.recommendation) {
        setRecommendation(recData.recommendation);
      }
    } catch {
      setConnected(false);
      setError("Cannot reach AI Engine — showing last known state");
      if (prevConnected.current === true) {
        addToast({ type: "warning", title: "Telemetry Offline", message: `Cannot reach ${AI_ENGINE_URL}`, duration: 5000 });
        pushEvent("offline", "Telemetry stream lost", `Could not reach ${AI_ENGINE_URL}`);
      }
      prevConnected.current = false;
    }
  }, [addToast, pushEvent]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Derived stats
  const temps = cells.map((c) => c.temperature);
  const avgTemp = temps.length ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : "—";
  const maxTemp = temps.length ? Math.max(...temps).toFixed(1) : "—";
  const minTemp = temps.length ? Math.min(...temps).toFixed(1) : "—";
  const deltaT = temps.length ? (Math.max(...temps) - Math.min(...temps)).toFixed(1) : "—";
  const socValues = cells.map((c) => c.soc ?? 100);
  const avgSoc = socValues.length ? (socValues.reduce((a, b) => a + b, 0) / socValues.length).toFixed(0) : "—";

  const hottestCellId = cells.reduce((maxId, c, i, arr) => (c.temperature > arr[maxId].temperature ? i : maxId), 0);
  const coolestCellId = cells.reduce((minId, c, i, arr) => (c.temperature < arr[minId].temperature ? i : minId), 0);
  const thermalStatus = getThermalStatus(recommendation);

  const formatElapsed = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  return (
    <div className="dashboard-root">
      {/* ── Top Navbar ──────────────────────────────────────────────────────────── */}
      <header className="navbar" id="navbar">
        <div className="navbar-brand">
          <Link to="/" style={{ textDecoration: "none", color: "inherit", display: "flex", alignItems: "center", gap: "10px" }}>
            <span className="navbar-logo">BT</span>
            <div>
              <span className="navbar-title">BTMS // DIGITAL TWIN</span>
              <span className="navbar-subtitle">BATTERY THERMAL MANAGEMENT SYSTEM</span>
            </div>
          </Link>
        </div>

        <div className="navbar-meta">
          <ExportButton cells={cells} history={history} />

          <button
            onClick={toggleFullscreen}
            title={`${isFullscreen ? "Exit" : "Enter"} fullscreen (F)`}
            style={{
              background: "var(--glass-1)",
              border: "1.5px solid var(--glass-border-bright)",
              borderRadius: "var(--r-sm)",
              color: "var(--bw-500)",
              fontSize: 11,
              fontWeight: 700,
              padding: "4px 10px",
              cursor: "pointer",
              letterSpacing: "0.06em",
              fontFamily: "var(--font-sans)",
            }}
          >
            {isFullscreen ? "⊡" : "⊞"} {isFullscreen ? "Exit" : "Fullscreen"}
          </button>

          <Link
            to="/"
            style={{ color: "#aaa", fontSize: "12px", textDecoration: "none", padding: "4px 8px", border: "1px solid #333", borderRadius: "4px", fontWeight: "600" }}
          >
            ← Landing
          </Link>

          {isAuthenticated ? (
            <button
              id="user-chip"
              onClick={() => setProfileOpen(true)}
              title="Open profile panel (P)"
              style={{ display: "flex", alignItems: "center", gap: "8px", background: "#161616", border: "1px solid #333", padding: "3px 10px", borderRadius: "4px", fontSize: "12px", cursor: "pointer", color: "inherit" }}
            >
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#4ade80" }} />
              <span style={{ fontWeight: "700", color: "#fff" }}>{user?.username}</span>
              <span style={{ color: "#666", fontSize: "10px", textTransform: "uppercase" }}>({user?.role || "operator"})</span>
            </button>
          ) : (
            <Link to="/login" style={{ background: "#fff", color: "#000", fontSize: "12px", fontWeight: "700", textDecoration: "none", padding: "4px 10px", borderRadius: "4px" }}>
              Sign In
            </Link>
          )}

          <span className="runtime-pill" title="Elapsed session time">Runtime {formatElapsed(elapsed)}</span>

          <div className={`connection-badge ${connected ? "connected" : "disconnected"}`} id="conn-badge">
            <span className="dot" />
            <span>{connected ? "LIVE TELEMETRY" : "OFFLINE"}</span>
          </div>

          <span className="pack-id-chip" id="pack-id-chip">PACK: BTMS-PACK-001</span>

          {tick !== null && (
            <span className="tick-counter" id="tick-counter">TICK #{tick}</span>
          )}
        </div>
      </header>

      {/* ── Error Banner ───────────────────────────────────────────────────────── */}
      {error && (
        <div className="error-banner" id="error-banner" role="alert">
          <span className="error-icon">⚠</span>
          <span>{error}</span>
        </div>
      )}

      {/* ── Stats Overview ─────────────────────────────────────────────────────── */}
      <section className="stats-bar" id="stats-bar" aria-label="Pack statistics">
        <StatCard label="Avg Cell Temp" value={avgTemp} unit="°C" valueClass="normal" id="stat-avg-temp" sub="10-cell pack mean" />
        <StatCard
          label="Peak Cell Temp" value={maxTemp} unit="°C"
          valueClass={parseFloat(maxTemp) > 45 ? "critical" : parseFloat(maxTemp) > 40 ? "warning" : "normal"}
          id="stat-max-temp"
          sub={`Cell C0${hottestCellId} · ${parseFloat(maxTemp) > 45 ? "EXCEEDS 45°C" : "within limits"}`}
        />
        <StatCard label="Min Cell Temp" value={minTemp} unit="°C" valueClass="normal" id="stat-min-temp" sub={`Cell C0${coolestCellId} · intake`} />
        <StatCard
          label="Pack Differential ΔT" value={deltaT} unit="°C"
          valueClass={parseFloat(deltaT) > 5 ? "warning" : "normal"}
          id="stat-delta-t"
          sub={parseFloat(deltaT) > 5 ? "Exceeds 5°C target" : "Within spec (<5°C)"}
        />
        <StatCard
          label="Pack Avg SoC" value={avgSoc} unit="%"
          valueClass={parseFloat(avgSoc) < 20 ? "warning" : "normal"}
          id="stat-soc" sub="Lithium NMC pack"
        />
      </section>

      {/* ── Main Content Grid ──────────────────────────────────────────────────── */}
      <main className="main-content">
        {/* aria-live for screen readers */}
        <div aria-live="assertive" className="sr-only" id="spike-live-region">
          {cells.some((c) => c.is_spike) ? `Thermal spike detected in ${cells.filter((c) => c.is_spike).length} cells` : ""}
        </div>

        {/* Left column: cell grid + trend chart */}
        <div className="cell-grid-col">
          <CellGrid cells={cells} cellHistory={cellHistory} tick={tick} onSelectCell={_setSelectedCell} />
          <PackTrendChart history={history} />

          {/* Event Timeline — beneath chart */}
          <div style={{ marginTop: 16 }}>
            <EventTimeline
              ref={eventLogRef}
              events={events}
              onClear={() => setEvents([])}
            />
          </div>
        </div>

        {/* Right column: recommendations + service health */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <RecommendationsPanel recommendation={recommendation} thermalStatus={thermalStatus} />
          <OperatorCopilot cells={cells} onSelectCell={_setSelectedCell} />
          <ServiceHealthMonitor />
        </div>
      </main>

      {/* ── Footer Status Strip ────────────────────────────────────────────────── */}
      <footer className="footer-strip" id="footer-strip">
        <span>CFD: Graetz &amp; Dittus-Boelter · Dh=1mm</span>
        <span className="footer-sep">|</span>
        <span>Al₂O₃/H₂O · 0.5–3.0% Vol</span>
        <span className="footer-sep">|</span>
        <span>Re 400–700 laminar</span>
        <span className="footer-sep">|</span>
        <span>SQLite Auth</span>
        <span className="footer-sep" style={{ marginLeft: "auto" }}>|</span>
        <span className="kbd-hint"><kbd>P</kbd> Profile</span>
        <span className="kbd-hint"><kbd>F</kbd> Fullscreen</span>
        <span className="kbd-hint"><kbd>↓</kbd> Export</span>
        <span className="kbd-hint"><kbd>click</kbd> Cell detail</span>
      </footer>

      {/* ── Profile Panel ─────────────────────────────────────────────────────── */}
      {profileOpen && (
        <ProfilePanel onClose={() => setProfileOpen(false)} sessionStart={startTime} />
      )}

      {/* ── Cell Detail Modal ─────────────────────────────────────────────────── */}
      {selectedCell && (
        <CellDetailModal
          cell={selectedCell}
          sparkData={cellHistory.get(selectedCell.cell_id) || []}
          onClose={() => _setSelectedCell(null)}
        />
      )}
    </div>
  );
}
