/* ──────────────────────────────────────────────────────────
   EPREL Tyre Scanner — vanilla JS PWA
   Scansiona EAN + QR → salva in localStorage → esporta CSV
   ────────────────────────────────────────────────────────── */

"use strict";

// ─── Storage keys ──────────────────────────────────────────
const LS_SESSION = "eprel_scanner_session";
const IDB_NAME = "eprel_scanner_backup";
const IDB_STORE = "items";

// ─── State ─────────────────────────────────────────────────
const state = {
  items: [],          // [{id, ean, eprel_id, dot, qty, notes, ts}]
  draft: null,        // currently editing item (in view-new)
  scanner: null,      // html5Qrcode instance
  scanMode: null,     // "ean" | "qr"
  view: "home",
};

// ─── DOM shortcuts ─────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── IndexedDB (ridondante: ogni 10 articoli) ──────────────
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function backupToIDB(items) {
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    store.clear();
    for (const item of items) store.put(item);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch (e) {
    console.warn("IDB backup failed:", e);
  }
}

// ─── Persistence ───────────────────────────────────────────
function saveSession() {
  try {
    localStorage.setItem(LS_SESSION, JSON.stringify(state.items));
    showSavedToast();
    // Backup ridondante ogni 10 articoli
    if (state.items.length > 0 && state.items.length % 10 === 0) {
      backupToIDB(state.items);
    }
  } catch (e) {
    alert("Errore di salvataggio: " + e.message);
  }
}

async function loadSession() {
  try {
    const raw = localStorage.getItem(LS_SESSION);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.items = parsed;
        return;
      }
    }
    // Fallback: prova a recuperare da IndexedDB
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const req = store.getAll();
    state.items = await new Promise((res) => {
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => res([]);
    });
    db.close();
    if (state.items.length > 0) {
      // Re-sync to localStorage
      localStorage.setItem(LS_SESSION, JSON.stringify(state.items));
    }
  } catch (e) {
    console.warn("loadSession failed:", e);
    state.items = [];
  }
}

let saveDebounceTimer = null;
function saveSessionDebounced(delay = 500) {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(saveSession, delay);
}

let toastTimer = null;
function showSavedToast() {
  const t = $("#save-toast");
  t.hidden = false;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => { t.hidden = true; }, 200);
  }, 900);
}

// ─── ID generation ─────────────────────────────────────────
function nextSequenceId() {
  const max = state.items
    .map((it) => parseInt((it.id || "").replace(/^S/, ""), 10))
    .filter((n) => !Number.isNaN(n))
    .reduce((a, b) => Math.max(a, b), 0);
  return "S" + String(max + 1).padStart(4, "0");
}

// ─── DOT validation (mirror della logica desktop) ──────────
const DOT_OLD_THRESHOLD_YEARS = 2;

function parseDotYear(value) {
  if (value === null || value === undefined) return null;
  let text = String(value).trim();
  if (!text) return null;
  // Esplicito 4-digit year 1980-2099
  const m = text.match(/(?<!\d)(19[89]\d|20\d{2})(?!\d)/);
  if (m) return parseInt(m[1], 10);
  const digits = text.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length >= 4) return 2000 + parseInt(digits.slice(-2), 10);
  if (digits.length === 3) return 2000 + parseInt(digits.slice(-2), 10);
  if (digits.length === 2) return 2000 + parseInt(digits, 10);
  return null;
}

function dotWarning(value) {
  const year = parseDotYear(value);
  if (year === null) return null;
  const age = new Date().getFullYear() - year;
  if (age > DOT_OLD_THRESHOLD_YEARS) {
    return `⚠ DOT ${year} (${age} anni)`;
  }
  return null;
}

// ─── Render: home ──────────────────────────────────────────
function renderHome() {
  $("#count-num").textContent = state.items.length;
  $("#empty-state").hidden = state.items.length > 0;
  const list = $("#items-list");
  list.innerHTML = "";
  // Show most recent first
  const sorted = [...state.items].sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  for (const item of sorted) {
    const li = document.createElement("li");
    const eanShort = item.ean ? item.ean : "—";
    const eprelShort = item.eprel_id ? item.eprel_id : "—";
    const dotInfo = item.dot ? ` · DOT ${item.dot}` : "";
    li.innerHTML = `
      <span class="item-id">${escapeHtml(item.id)}</span>
      <div class="item-main">
        <div class="item-codes">EAN ${escapeHtml(eanShort)} · EPREL ${escapeHtml(eprelShort)}</div>
        <div class="item-meta">${escapeHtml(item.notes || "")}${dotInfo}</div>
      </div>
      <span class="item-qty">×${item.qty || 1}</span>
      <button class="item-delete" data-id="${escapeHtml(item.id)}" aria-label="Elimina">✕</button>
    `;
    list.appendChild(li);
  }
  // Attach delete handlers
  list.querySelectorAll(".item-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = btn.dataset.id;
      if (confirm(`Eliminare ${id}?`)) {
        state.items = state.items.filter((it) => it.id !== id);
        saveSession();
        renderHome();
      }
    });
  });

  // Resume banner
  const banner = $("#resume-banner");
  if (state.items.length > 0 && !banner.dataset.shown) {
    banner.textContent = `Sessione recuperata: ${state.items.length} articoli`;
    banner.hidden = false;
    banner.dataset.shown = "1";
    setTimeout(() => { banner.hidden = true; }, 4000);
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Navigation ────────────────────────────────────────────
function showView(name) {
  $$(".view").forEach((v) => v.classList.remove("active"));
  $("#view-" + name).classList.add("active");
  state.view = name;
}

// ─── New item flow ─────────────────────────────────────────
function startNewItem() {
  state.draft = {
    id: nextSequenceId(),
    ean: "",
    eprel_id: "",
    dot: "",
    qty: 1,
    notes: "",
    ts: new Date().toISOString(),
  };
  $("#seq-id").textContent = state.draft.id;
  $("#input-ean").value = "";
  $("#input-eprel").value = "";
  $("#input-dot").value = "";
  $("#input-qty").value = "1";
  $("#input-notes").value = "";
  $("#dot-hint").hidden = true;
  $("#dot-hint").textContent = "";
  $("#input-dot").classList.remove("warning");
  showView("new");
}

function commitDraft() {
  if (!state.draft) return;
  const ean = $("#input-ean").value.trim();
  const eprelId = $("#input-eprel").value.trim();
  if (!ean && !eprelId) {
    alert("Scansiona almeno EAN o codice EPREL prima di salvare.");
    return;
  }
  state.draft.ean = ean;
  state.draft.eprel_id = eprelId;
  state.draft.dot = $("#input-dot").value.trim();
  state.draft.qty = Math.max(1, parseInt($("#input-qty").value, 10) || 1);
  state.draft.notes = $("#input-notes").value.trim();
  state.draft.ts = new Date().toISOString();
  state.items.push(state.draft);
  state.draft = null;
  saveSession();
  renderHome();
  showView("home");
}

// ─── Scanner ───────────────────────────────────────────────
async function openScanner(mode) {
  state.scanMode = mode;
  $("#scan-title").textContent = mode === "ean" ? "Scansiona EAN" : "Scansiona QR EPREL";
  $("#scan-hint").textContent = mode === "ean"
    ? "Inquadra il barcode lineare"
    : "Inquadra il QR code dell'etichetta UE";
  showView("scanner");

  if (!window.Html5Qrcode) {
    alert("Libreria scanner non caricata. Verifica la connessione.");
    showView("new");
    return;
  }

  const formats = mode === "ean"
    ? [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128,
      ]
    : [Html5QrcodeSupportedFormats.QR_CODE];

  state.scanner = new Html5Qrcode("qr-reader", { formatsToSupport: formats });
  try {
    await state.scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 260, height: mode === "ean" ? 130 : 260 } },
      (decodedText) => onScanSuccess(decodedText),
      () => {} // ignore per-frame failures
    );
  } catch (err) {
    alert("Impossibile avviare la fotocamera: " + err.message + "\nVerifica i permessi.");
    closeScanner();
  }
}

async function closeScanner() {
  if (state.scanner) {
    try { await state.scanner.stop(); } catch (e) {}
    try { state.scanner.clear(); } catch (e) {}
    state.scanner = null;
  }
  showView("new");
}

async function onScanSuccess(decoded) {
  // Stop subito per evitare scan multipli
  await closeScanner();

  if (state.scanMode === "ean") {
    // EAN-13/8 sono solo cifre; UPC-A/E pure
    const digits = decoded.replace(/\D/g, "");
    if (!digits) {
      alert("Codice non riconosciuto come EAN.");
      return;
    }
    $("#input-ean").value = digits;
    state.draft.ean = digits;
    saveSessionDebounced();
  } else {
    // QR: estrai l'ID EPREL dall'URL
    const m = decoded.match(/\/(?:qr|tyres)\/(\d+)/i);
    const id = m ? m[1] : decoded.replace(/\D/g, "");
    if (!id) {
      alert("QR non riconosciuto. Atteso URL EPREL del tipo https://eprel.ec.europa.eu/qr/<id>");
      return;
    }
    $("#input-eprel").value = id;
    state.draft.eprel_id = id;
    saveSessionDebounced();
  }
}

// ─── CSV export ────────────────────────────────────────────
function csvCell(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportCsv() {
  if (state.items.length === 0) {
    alert("Nessun articolo da esportare.");
    return;
  }
  const headers = ["Internal ID", "EAN", "EPREL ID", "DOT", "Quantita", "Note", "Scansionato"];
  const lines = [headers.map(csvCell).join(",")];
  for (const it of state.items) {
    lines.push([
      it.id, it.ean, it.eprel_id, it.dot, it.qty, it.notes, it.ts,
    ].map(csvCell).join(","));
  }
  const csv = "﻿" + lines.join("\n");  // BOM per Excel
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().slice(0, 10);
  const filename = `eprel-scan-${ts}.csv`;

  // Try Web Share API first (iOS-friendly)
  if (navigator.canShare && navigator.canShare({ files: [new File([blob], filename)] })) {
    navigator.share({
      files: [new File([blob], filename, { type: "text/csv" })],
      title: filename,
    }).catch(() => downloadBlob(url, filename));
  } else {
    downloadBlob(url, filename);
  }
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function downloadBlob(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ─── Settings ──────────────────────────────────────────────
function openSettings() {
  showView("settings");
}

function resetSession() {
  if (!confirm("Cancellare tutti gli articoli scansionati? L'azione non è reversibile.")) return;
  state.items = [];
  saveSession();
  backupToIDB([]);
  renderHome();
  alert("Sessione cancellata.");
}

// ─── Wire up event handlers ────────────────────────────────
function attachHandlers() {
  $("#btn-new").addEventListener("click", startNewItem);
  $("#btn-export").addEventListener("click", exportCsv);
  $("#btn-back").addEventListener("click", () => {
    if (confirm("Annullare la scansione corrente?")) {
      state.draft = null;
      showView("home");
    }
  });
  $("#btn-cancel").addEventListener("click", () => {
    state.draft = null;
    showView("home");
  });
  $("#btn-add").addEventListener("click", commitDraft);

  $("#btn-scan-ean").addEventListener("click", () => openScanner("ean"));
  $("#btn-scan-qr").addEventListener("click", () => openScanner("qr"));
  $("#btn-scan-close").addEventListener("click", closeScanner);

  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-settings-back").addEventListener("click", () => showView("home"));
  $("#btn-reset").addEventListener("click", resetSession);

  $("#btn-qty-minus").addEventListener("click", () => {
    const el = $("#input-qty");
    el.value = Math.max(1, (parseInt(el.value, 10) || 1) - 1);
    saveSessionDebounced();
  });
  $("#btn-qty-plus").addEventListener("click", () => {
    const el = $("#input-qty");
    el.value = (parseInt(el.value, 10) || 1) + 1;
    saveSessionDebounced();
  });

  // Live DOT validation
  const dotInput = $("#input-dot");
  dotInput.addEventListener("input", () => {
    const warn = dotWarning(dotInput.value);
    const hint = $("#dot-hint");
    if (warn) {
      hint.textContent = warn;
      hint.className = "hint warning";
      hint.hidden = false;
      dotInput.classList.add("warning");
    } else {
      hint.hidden = true;
      hint.textContent = "";
      dotInput.classList.remove("warning");
    }
    saveSessionDebounced();
  });

  // Manual EAN/EPREL entry → auto-save
  $("#input-ean").addEventListener("input", saveSessionDebounced);
  $("#input-eprel").addEventListener("input", saveSessionDebounced);
  $("#input-notes").addEventListener("input", saveSessionDebounced);
}

// ─── Service worker registration ───────────────────────────
function registerSW() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./service-worker.js")
        .catch((err) => console.warn("SW registration failed:", err));
    });
  }
}

// ─── Boot ──────────────────────────────────────────────────
async function boot() {
  await loadSession();
  attachHandlers();
  renderHome();
  showView("home");
  registerSW();
}

document.addEventListener("DOMContentLoaded", boot);
