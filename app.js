/* ──────────────────────────────────────────────────────────
   EPREL Tyre Scanner — vanilla JS PWA
   Scansiona EAN + QR → salva in localStorage → esporta CSV
   ────────────────────────────────────────────────────────── */

"use strict";

// ─── Storage keys ──────────────────────────────────────────
const LS_SESSION = "eprel_scanner_session";
const LS_API_KEY = "eprel_scanner_api_key";
const LS_PREVIEW_PREFIX = "eprel_preview_";
const IDB_NAME = "eprel_scanner_backup";
const IDB_STORE = "items";

// ─── EPREL config ──────────────────────────────────────────
const EPREL_BASE = "https://eprel.ec.europa.eu/api/products/tyres";

// ─── State ─────────────────────────────────────────────────
const state = {
  items: [],          // [{id, ean, eprel_id, dot, qty, notes, ts, brand, model, size, speed, energy, wet, noise}]
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

// ─── EPREL API ─────────────────────────────────────────────
async function fetchEprelPreview(eprelId) {
  const apiKey = sanitizeApiKey(localStorage.getItem(LS_API_KEY) || "");
  if (!apiKey) return null;

  // Cache hit?
  try {
    const cached = sessionStorage.getItem(LS_PREVIEW_PREFIX + eprelId);
    if (cached) return JSON.parse(cached);
  } catch (e) {}

  const url = `${EPREL_BASE}?eprelRegistrationNumber=${encodeURIComponent(eprelId)}&_limit=1`;
  const resp = await fetch(url, {
    headers: { "x-api-key": apiKey, Accept: "application/json" },
  });
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      throw new Error("API Key non valida o non attiva (HTTP " + resp.status + ")");
    }
    throw new Error("EPREL HTTP " + resp.status);
  }
  const data = await resp.json();
  const hits = (data && data.hits) || [];
  const record = hits[0] || null;
  if (record) {
    try {
      sessionStorage.setItem(LS_PREVIEW_PREFIX + eprelId, JSON.stringify(record));
    } catch (e) {}
  }
  return record;
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
    const brandLine = item.brand
      ? `${item.brand}${item.size ? " · " + item.size : ""}${item.speed ? " " + item.speed : ""}`
      : "";
    const dotInfo = item.dot ? ` · DOT ${item.dot}` : "";
    li.innerHTML = `
      <span class="item-id">${escapeHtml(item.id)}</span>
      <div class="item-main">
        ${brandLine ? `<div>${escapeHtml(brandLine)}</div>` : ""}
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
  hidePreview();
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
  // Snapshot of fetched preview if any
  const prevBrand = $("#prev-brand").textContent;
  if (prevBrand) {
    state.draft.brand = prevBrand;
    state.draft.model = $("#prev-model").textContent;
    state.draft.size = $("#prev-size").textContent;
    state.draft.speed = $("#prev-speed").textContent;
    state.draft.energy = $("#prev-energy").textContent;
    state.draft.wet = $("#prev-wet").textContent;
    state.draft.noise = $("#prev-noise").textContent;
  }
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

  // Restringi i formati accettati al tipo di codice che ci aspettiamo.
  // SENZA questa restrizione il lettore può catturare i codici "Code 128"
  // del distributore (lotto/SKU interni), che NON sono l'EAN del prodotto.
  // Code 128 NON è in lista per EAN mode — quello è il bug che dava cifre
  // sbagliate. Niente qrbox (immagine intera) per tolleranza inquadratura.
  let scannerConfig = {};
  if (typeof Html5QrcodeSupportedFormats !== "undefined") {
    const formats = mode === "ean"
      ? [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
        ]
      : [Html5QrcodeSupportedFormats.QR_CODE];
    scannerConfig = { formatsToSupport: formats };
  }

  state.scanner = new Html5Qrcode("qr-reader", scannerConfig);
  try {
    await state.scanner.start(
      { facingMode: "environment" },
      { fps: 15 },
      (decodedText) => onScanSuccess(decodedText),
      () => {} // ignore per-frame failures
    );
  } catch (err) {
    alert("Impossibile avviare la fotocamera: " + err.message + "\nVerifica i permessi.");
    closeScanner();
  }
}

function closeScanner() {
  // Hide the view IMMEDIATELY so the user is never stuck on a frozen scanner
  // screen if .stop() hangs (it can on some mobile browsers). Cleanup runs in
  // the background — we don't await it.
  showView("new");
  if (state.scanner) {
    const sc = state.scanner;
    state.scanner = null;
    Promise.resolve().then(async () => {
      try { await sc.stop(); } catch (e) { /* ignore */ }
      try { sc.clear(); } catch (e) { /* ignore */ }
    });
  }
}

async function onScanSuccess(decoded) {
  // Guard: la libreria può chiamare il callback più volte per lo stesso
  // frame; ignoriamo tutto dopo la prima chiusura.
  if (!state.scanner) return;
  closeScanner();

  if (state.scanMode === "ean") {
    // EAN-13/8 sono solo cifre; UPC-A/E pure
    const digits = decoded.replace(/\D/g, "");
    if (!digits) {
      alert("Codice non riconosciuto come EAN.");
      return;
    }
    // Lunghezze EAN/UPC tipiche: 8 (EAN-8), 12 (UPC-A), 13 (EAN-13), 14 (GTIN-14)
    if (![8, 12, 13, 14].includes(digits.length)) {
      const ok = confirm(
        `Codice letto: ${digits}\n\n` +
        `Ha ${digits.length} cifre, non corrisponde a un EAN/UPC standard ` +
        `(8, 12, 13, o 14 cifre). Probabilmente è un codice interno del distributore, ` +
        `non l'EAN del prodotto.\n\nVuoi usarlo lo stesso?`
      );
      if (!ok) return;
    }
    $("#input-ean").value = digits;
    state.draft.ean = digits;
    saveSessionDebounced();
  } else {
    // QR mode: prova a estrarre l'ID EPREL dal contenuto. Strategia:
    //   1. URL EPREL standard (qr/, tyres/, product/) → usa direttamente
    //   2. Solo numero → trattalo come ID
    //   3. URL non EPREL ma con un numero → chiedi conferma all'utente
    //   4. Altro → mostra errore con il contenuto letto
    const id = extractEprelId(decoded);
    if (!id) {
      alert(
        "QR non riconosciuto come EPREL.\n\n" +
        "Letto: " + decoded.substring(0, 200) + "\n\n" +
        "Atteso un URL EPREL o un ID numerico. " +
        "Puoi anche inserire l'ID a mano nel campo qui sotto."
      );
      return;
    }
    $("#input-eprel").value = id;
    state.draft.eprel_id = id;
    saveSessionDebounced();
    // Trigger preview fetch
    await loadPreview(id);
  }
}

// ─── Estrai EPREL ID da varie forme (URL, ID nudo, testo) ──────
function extractEprelId(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (!s) return null;

  // 1. URL EPREL standard: /qr/12345, /tyres/12345, /product/...12345
  const urlMatch = s.match(/\/(?:qr|tyres|product)[a-z\/]*\/(\d{3,10})/i);
  if (urlMatch) return urlMatch[1];

  // 2. Solo numero (es. "2419173" o "  2419173  ")
  if (/^\d{3,10}$/.test(s)) return s;

  // 3. Contiene esattamente un numero ragionevole come ID — chiedi conferma
  const numbers = s.match(/\d{3,10}/g);
  if (numbers && numbers.length === 1) {
    const ok = confirm(
      `Letto: ${s.substring(0, 120)}\n\n` +
      `Non è un URL EPREL standard. Provo a usare il numero ${numbers[0]} come ID. OK?`
    );
    return ok ? numbers[0] : null;
  }
  if (numbers && numbers.length > 1) {
    const longest = numbers.sort((a, b) => b.length - a.length)[0];
    const ok = confirm(
      `Letto: ${s.substring(0, 120)}\n\n` +
      `Più numeri trovati. Uso il più lungo: ${longest}. OK?`
    );
    return ok ? longest : null;
  }
  return null;
}

// ─── Preview ───────────────────────────────────────────────
function hidePreview() {
  $("#preview-card").hidden = true;
  $(".preview-loading").hidden = true;
  $(".preview-error").hidden = true;
  $(".preview-content").hidden = true;
  $("#prev-brand").textContent = "";
  $("#prev-model").textContent = "";
  $("#prev-size").textContent = "";
  $("#prev-speed").textContent = "";
  $("#prev-energy").textContent = "—";
  $("#prev-wet").textContent = "—";
  $("#prev-noise").textContent = "—";
}

async function loadPreview(eprelId) {
  const apiKey = localStorage.getItem(LS_API_KEY);
  if (!apiKey) return; // niente chiave → niente preview

  const card = $("#preview-card");
  const loading = card.querySelector(".preview-loading");
  const error = card.querySelector(".preview-error");
  const content = card.querySelector(".preview-content");
  card.hidden = false;
  loading.hidden = false;
  error.hidden = true;
  content.hidden = true;

  try {
    const rec = await fetchEprelPreview(eprelId);
    loading.hidden = true;
    if (!rec) {
      error.textContent = "Nessun dato EPREL per ID " + eprelId;
      error.hidden = false;
      return;
    }
    $("#prev-brand").textContent = rec.supplierOrTrademark || "";
    $("#prev-model").textContent = rec.commercialName || rec.modelIdentifier || "";
    $("#prev-size").textContent = rec.tyreDesignation || rec.sizeDesignation || "";
    $("#prev-speed").textContent = rec.speedCategorySymbol || "—";
    $("#prev-energy").textContent = rec.energyClass || "—";
    $("#prev-wet").textContent = rec.wetGripClass || "—";
    $("#prev-noise").textContent =
      rec.externalRollingNoiseValue != null
        ? rec.externalRollingNoiseValue + " dB"
        : "—";
    content.hidden = false;
  } catch (e) {
    loading.hidden = true;
    error.textContent = "Errore preview: " + e.message;
    error.hidden = false;
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
  $("#input-api-key").value = localStorage.getItem(LS_API_KEY) || "";
  $("#test-key-result").textContent = "";
  showView("settings");
}

function sanitizeApiKey(value) {
  // Rimuove TUTTI i caratteri whitespace (inclusi non-breaking space, zero-width
  // space e tabulazioni) che vengono frequentemente inseriti dal copia-incolla
  // di iOS dal PDF. .trim() da solo non basta: lascia gli spazi interni.
  return String(value || "").replace(/[\s ​‌‍﻿]/g, "");
}

async function testApiKey() {
  const inp = $("#input-api-key");
  const key = sanitizeApiKey(inp.value);
  // Riscrivi nel campo la chiave pulita: l'utente vede subito se c'erano
  // caratteri estranei (la lunghezza cambia)
  if (inp.value !== key) inp.value = key;
  const out = $("#test-key-result");
  if (!key) {
    out.textContent = "Inserisci una chiave da testare.";
    out.style.color = "var(--text-muted)";
    return;
  }
  out.textContent = "Test in corso… (lunghezza chiave: " + key.length + ")";
  out.style.color = "var(--text-muted)";
  try {
    const resp = await fetch(`${EPREL_BASE}?_limit=1`, {
      headers: { "x-api-key": key, Accept: "application/json" },
    });
    if (resp.ok) {
      out.textContent = "✓ Chiave valida e attiva.";
      out.style.color = "var(--success)";
      localStorage.setItem(LS_API_KEY, key);
    } else if (resp.status === 401 || resp.status === 403) {
      out.textContent = `✗ Chiave rifiutata (HTTP ${resp.status}). Verifica di aver copiato la chiave senza spazi/caratteri extra.`;
      out.style.color = "var(--danger)";
    } else {
      out.textContent = `✗ Errore HTTP ${resp.status}`;
      out.style.color = "var(--danger)";
    }
  } catch (e) {
    // Browser fetch throws TypeError for CORS-blocked responses too. EPREL
    // returns 403 senza header CORS quando la chiave è invalida, e il browser
    // lo segnala come errore di rete generico. Quindi: chiave sbagliata è la
    // causa di gran lunga più probabile.
    out.innerHTML =
      "✗ Errore di rete.<br>" +
      "Causa più probabile: chiave incollata male (spazi, caratteri mancanti, righe nuove). " +
      "Tocca 👁 per controllare quello che hai inserito.<br>" +
      "<small>Dettaglio: " + escapeHtml(e.message || String(e)) + "</small>";
    out.style.color = "var(--danger)";
  }
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
  $("#btn-scan-close-bottom").addEventListener("click", closeScanner);

  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-settings-back").addEventListener("click", () => showView("home"));
  $("#btn-test-key").addEventListener("click", testApiKey);
  $("#btn-toggle-key").addEventListener("click", () => {
    const inp = $("#input-api-key");
    inp.type = inp.type === "password" ? "text" : "password";
  });
  // Auto-save: persist the key as soon as the user types/pastes it. The "Test
  // connessione" button is now just a verification step — saving doesn't
  // depend on success.
  $("#input-api-key").addEventListener("input", () => {
    const key = sanitizeApiKey($("#input-api-key").value);
    if (key) {
      localStorage.setItem(LS_API_KEY, key);
    } else {
      localStorage.removeItem(LS_API_KEY);
    }
  });
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

  // Manual EAN/EPREL entry → auto-save (e preview se EPREL)
  $("#input-ean").addEventListener("input", saveSessionDebounced);
  $("#input-eprel").addEventListener("change", () => {
    const inp = $("#input-eprel");
    const raw = inp.value.trim();
    if (!raw) {
      saveSessionDebounced();
      return;
    }
    // Auto-extract ID if user pasted a URL (or kept the URL as-is)
    const id = extractEprelId(raw);
    if (id && id !== raw) {
      inp.value = id;
    }
    if (id) loadPreview(id);
    saveSessionDebounced();
  });
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
