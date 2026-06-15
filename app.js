// ============================================================
// CONFIG
// ============================================================
const GOOGLE_CLIENT_ID = "152893984760-qlc6hvdlusademktqoo7jdjbiebij4qc.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const DRIVE_FILE_NAME = "recurring-log-data.json";

const STORAGE_KEY = "recurring-log-data-v1";
const SETTINGS_KEY = "recurring-log-settings-v1";

// ============================================================
// DEFAULT DATA
// ============================================================
const CATEGORY_PRESETS = [
  { id: "home", name: "Home", icon: "🔥", color: "#D9683C" },
  { id: "vehicle", name: "Vehicle", icon: "🏍️", color: "#3C7A89" },
  { id: "water", name: "Water & Filters", icon: "💧", color: "#4A90A4" },
  { id: "maintenance", name: "Maintenance", icon: "🔧", color: "#8B7355" },
  { id: "other", name: "Other", icon: "📦", color: "#7A6C8E" },
];

const SEED_ITEMS = [
  { id: "1", name: "Gas Cylinder Refill", categoryId: "home", history: [] },
  { id: "2", name: "Bike Servicing", categoryId: "vehicle", history: [] },
  { id: "3", name: "Water Filter Service", categoryId: "water", history: [] },
];

// ============================================================
// STATE
// ============================================================
// data shape: { categories: [...], items: [...], updatedAt: number }
let state = loadLocalState();
let settings = loadSettings();

// UI-only state (not persisted)
let expanded = {};
let addingTo = null;
let logDateFor = null;
let logDateValue = "";
let movingItem = null;

// sync state
let accessToken = null;
let driveFileId = null;
let syncStatusState = "idle"; // idle | online | offline | syncing | error
let syncInProgress = false;
let pendingSync = false;

// ============================================================
// PERSISTENCE - LOCAL
// ============================================================
function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items) && Array.isArray(parsed.categories)) {
        if (!parsed.updatedAt) parsed.updatedAt = Date.now();
        return parsed;
      }
    }
  } catch (e) {
    console.error("Failed to load local state", e);
  }
  return { categories: CATEGORY_PRESETS, items: SEED_ITEMS, updatedAt: Date.now() };
}

function saveLocalState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("Failed to save local state", e);
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { storageMode: "local" }; // "local" | "drive"
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {}
}

// Call this after any data mutation
function commitChange() {
  state.updatedAt = Date.now();
  saveLocalState();
  render();
  if (settings.storageMode === "drive") {
    scheduleSync();
  }
}

// ============================================================
// MERGE LOGIC (for combining local + remote when both have changes)
// ============================================================
function mergeStates(local, remote) {
  if (!remote) return local;
  if (!local) return remote;

  const catMap = {};
  (remote.categories || []).forEach((c) => (catMap[c.id] = c));
  (local.categories || []).forEach((c) => (catMap[c.id] = catMap[c.id] || c));
  const categories = Object.values(catMap);

  const itemMap = {};

  function ingest(items) {
    (items || []).forEach((it) => {
      if (!itemMap[it.id]) {
        itemMap[it.id] = {
          id: it.id,
          name: it.name,
          categoryId: it.categoryId,
          history: it.history ? it.history.slice() : [],
          deleted: !!it.deleted,
        };
      } else {
        const existing = itemMap[it.id];
        // merge history by union of dates
        const histSet = new Set(existing.history);
        (it.history || []).forEach((d) => histSet.add(d));
        existing.history = Array.from(histSet).sort().reverse();
        // deleted wins if either side deleted
        if (it.deleted) existing.deleted = true;
        // categoryId / name: prefer whichever record is "newer" - use remote vs local timestamps as tiebreak
        // simple approach: keep existing unless this one looks more "current" (no good signal) - keep first seen
      }
    });
  }

  // ingest remote first (baseline), then local (local edits to name/category take precedence)
  ingest(remote.items);
  (local.items || []).forEach((it) => {
    if (itemMap[it.id]) {
      itemMap[it.id].name = it.name;
      itemMap[it.id].categoryId = it.categoryId;
      if (it.deleted) itemMap[it.id].deleted = true;
      const histSet = new Set(itemMap[it.id].history);
      (it.history || []).forEach((d) => histSet.add(d));
      itemMap[it.id].history = Array.from(histSet).sort().reverse();
    } else {
      itemMap[it.id] = {
        id: it.id,
        name: it.name,
        categoryId: it.categoryId,
        history: it.history ? it.history.slice() : [],
        deleted: !!it.deleted,
      };
    }
  });

  const items = Object.values(itemMap).filter((it) => !it.deleted);

  return { categories, items, updatedAt: Date.now() };
}

// ============================================================
// HELPERS
// ============================================================
function fmtDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

function daysAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function daysBetween(a, b) {
  const diff = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

function getGaps(history) {
  const sorted = history.slice().reverse();
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push({ date: sorted[i], days: daysBetween(sorted[i - 1], sorted[i]) });
  }
  return gaps;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2200);
}

// ============================================================
// ACTIONS (data mutation)
// ============================================================
function toggleExpand(id) {
  expanded[id] = !expanded[id];
  render();
}

function startAdd(categoryId) {
  addingTo = categoryId;
  render();
  const input = document.querySelector(`[data-add-input="${categoryId}"]`);
  if (input) input.focus();
}

function cancelAdd() {
  addingTo = null;
  render();
}

function addItem(categoryId) {
  const input = document.querySelector(`[data-add-input="${categoryId}"]`);
  const value = input ? input.value.trim() : "";
  if (!value) return;
  const newItem = { id: String(Date.now()), name: value, categoryId, history: [] };
  state.items.push(newItem);
  addingTo = null;
  commitChange();
}

function startLog(itemId) {
  logDateFor = itemId;
  logDateValue = todayStr();
  render();
}

function cancelLog() {
  logDateFor = null;
  render();
}

function saveLog(itemId) {
  const input = document.querySelector(`[data-log-input="${itemId}"]`);
  const dateStr = input ? input.value : "";
  if (!dateStr) return;
  const item = state.items.find((it) => it.id === itemId);
  if (item) {
    item.history.push(dateStr);
    item.history.sort();
    item.history.reverse();
  }
  logDateFor = null;
  commitChange();
}

function deleteEntry(itemId, dateStr) {
  const item = state.items.find((it) => it.id === itemId);
  if (item) {
    item.history = item.history.filter((d) => d !== dateStr);
  }
  commitChange();
}

function deleteItem(itemId) {
  if (!confirm("Delete this item and all its history?")) return;
  const item = state.items.find((it) => it.id === itemId);
  if (item) item.deleted = true;
  state.items = state.items.filter((it) => it.id !== itemId);
  commitChange();
}

function startMove(itemId) {
  movingItem = itemId;
  render();
}

function cancelMove() {
  movingItem = null;
  render();
}

function moveItem(itemId, newCategoryId) {
  const item = state.items.find((it) => it.id === itemId);
  if (item) item.categoryId = newCategoryId;
  movingItem = null;
  commitChange();
}

// ============================================================
// GOOGLE DRIVE SYNC
// ============================================================
let tokenClient = null;

function initGoogleClient() {
  if (typeof google === "undefined" || !google.accounts) {
    setTimeout(initGoogleClient, 300);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (resp) => {
      if (resp.error) {
        console.error("Token error", resp);
        setSyncStatus("error");
        return;
      }
      accessToken = resp.access_token;
      onSignedIn();
    },
  });

  // try silent sign-in if previously connected
  if (settings.storageMode === "drive") {
    requestToken(true);
  }
}

function requestToken(silent) {
  if (!tokenClient) return;
  try {
    tokenClient.requestAccessToken({ prompt: silent ? "none" : "consent" });
  } catch (e) {
    console.error(e);
  }
}

function onSignedIn() {
  showToast("Connected to Google Drive");
  syncWithDrive().then(() => {
    settings.storageMode = "drive";
    saveSettings();
    closeSettings();
    render();
  });
}

function setSyncStatus(s) {
  syncStatusState = s;
  renderSyncStatus();
}

function renderSyncStatus() {
  const el = document.getElementById("syncStatus");
  if (!el) return;
  if (settings.storageMode === "local") {
    el.innerHTML = `<span class="sync-dot offline"></span> Saved on this device`;
    return;
  }
  let label = "";
  let dotClass = "offline";
  if (!navigator.onLine) {
    label = "Offline — changes saved locally, will sync when back online";
    dotClass = "offline";
  } else if (syncStatusState === "syncing") {
    label = "Syncing with Google Drive…";
    dotClass = "syncing";
  } else if (syncStatusState === "error") {
    label = "Sync error — will retry";
    dotClass = "error";
  } else {
    label = "Synced with Google Drive";
    dotClass = "online";
  }
  el.innerHTML = `<span class="sync-dot ${dotClass}"></span> ${label}`;
}

// Find or create the app data file on Drive
async function getOrCreateDriveFile() {
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${DRIVE_FILE_NAME}'&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!listRes.ok) throw new Error("Drive list failed: " + listRes.status);
  const listData = await listRes.json();
  if (listData.files && listData.files.length > 0) {
    return listData.files[0].id;
  }

  // create new file
  const metadata = { name: DRIVE_FILE_NAME, parents: ["appDataFolder"] };
  const createRes = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(metadata),
  });
  if (!createRes.ok) throw new Error("Drive create failed: " + createRes.status);
  const createData = await createRes.json();
  return createData.id;
}

async function downloadDriveFile(fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Drive download failed: " + res.status);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function uploadDriveFile(fileId, data) {
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    }
  );
  if (!res.ok) throw new Error("Drive upload failed: " + res.status);
}

async function syncWithDrive() {
  if (!accessToken) {
    requestToken(true);
    return;
  }
  if (syncInProgress) {
    pendingSync = true;
    return;
  }
  if (!navigator.onLine) {
    setSyncStatus("offline");
    return;
  }

  syncInProgress = true;
  setSyncStatus("syncing");

  try {
    if (!driveFileId) {
      driveFileId = await getOrCreateDriveFile();
    }
    const remote = await downloadDriveFile(driveFileId);
    const merged = mergeStates(state, remote);

    state = merged;
    saveLocalState();
    await uploadDriveFile(driveFileId, state);

    setSyncStatus("online");
    render();
  } catch (e) {
    console.error("Sync error", e);
    setSyncStatus("error");
  } finally {
    syncInProgress = false;
    if (pendingSync) {
      pendingSync = false;
      syncWithDrive();
    }
  }
}

let syncDebounceTimer = null;
function scheduleSync() {
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => {
    syncWithDrive();
  }, 1200);
}

function disconnectDrive() {
  settings.storageMode = "local";
  accessToken = null;
  driveFileId = null;
  saveSettings();
  setSyncStatus("idle");
  renderSyncStatus();
  closeSettings();
  showToast("Switched to this device only");
}

// ============================================================
// ONLINE/OFFLINE LISTENERS
// ============================================================
window.addEventListener("online", () => {
  if (settings.storageMode === "drive") {
    syncWithDrive();
  } else {
    renderSyncStatus();
  }
});
window.addEventListener("offline", () => {
  renderSyncStatus();
});

// ============================================================
// SETTINGS MODAL
// ============================================================
let modalSelection = null;

function openSettings() {
  modalSelection = settings.storageMode;
  updateModalUI();
  document.getElementById("settingsModal").classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settingsModal").classList.add("hidden");
}

function selectStorageOption(mode) {
  modalSelection = mode;
  updateModalUI();
}

function updateModalUI() {
  const localOpt = document.getElementById("optionLocal");
  const driveOpt = document.getElementById("optionDrive");
  const actionBtn = document.getElementById("settingsActionBtn");
  const accountRow = document.getElementById("accountRow");

  localOpt.classList.toggle("selected", modalSelection === "local");
  driveOpt.classList.toggle("selected", modalSelection === "drive");

  if (modalSelection === "local") {
    actionBtn.textContent = settings.storageMode === "drive" ? "Switch to this device" : "Selected";
    actionBtn.style.display = settings.storageMode === "drive" ? "block" : "none";
  } else {
    if (settings.storageMode === "drive" && accessToken) {
      actionBtn.textContent = "Sync now";
    } else {
      actionBtn.textContent = "Connect Google Drive";
    }
    actionBtn.style.display = "block";
  }

  if (settings.storageMode === "drive" && accessToken) {
    accountRow.innerHTML = `<div class="account-row">☁️ Connected to Google Drive &nbsp; <button class="link-btn danger" style="margin-left:auto" onclick="disconnectDrive()">Disconnect</button></div>`;
  } else {
    accountRow.innerHTML = "";
  }
}

function settingsAction() {
  if (modalSelection === "local") {
    if (settings.storageMode === "drive") disconnectDrive();
    else closeSettings();
  } else {
    if (settings.storageMode === "drive" && accessToken) {
      syncWithDrive();
      closeSettings();
    } else {
      requestToken(false);
    }
  }
}

// ============================================================
// RENDERING
// ============================================================
function renderIntervalChart(item, color) {
  const gaps = getGaps(item.history);
  if (gaps.length === 0) return "";

  let max = 1;
  gaps.forEach((g) => { if (g.days > max) max = g.days; });

  const bars = gaps.map((g) => {
    const h = Math.max(8, (g.days / max) * 48);
    return `
      <div class="chart-bar-col">
        <div class="chart-bar" style="height:${h}px; background:${color};" title="${g.days} days"></div>
        <span class="chart-bar-label">${g.days}d</span>
      </div>`;
  }).join("");

  return `
    <div class="chart-wrap">
      <p class="chart-label">Interval between entries</p>
      <div class="chart-bars">${bars}</div>
    </div>`;
}

function renderItem(item, cat) {
  const last = item.history.length > 0 ? item.history[0] : null;
  const isOpen = !!expanded[item.id];

  let html = `<div>`;

  html += `<div class="item-row">`;
  html += `<button class="item-main" onclick="toggleExpand('${item.id}')">`;
  html += `<svg class="chevron ${isOpen ? "open" : ""}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
  html += `<div class="item-info">`;
  html += `<p class="item-name">${escapeHtml(item.name)}</p>`;
  if (last) {
    html += `<p class="item-sub">Last: ${fmtDate(last)} · ${daysAgo(last)}d ago</p>`;
  } else {
    html += `<p class="item-sub">No history yet</p>`;
  }
  html += `</div></button>`;
  html += `<button class="log-btn" style="background:${cat.color}" onclick="startLog('${item.id}')">+ Log</button>`;
  html += `</div>`;

  if (logDateFor === item.id) {
    html += `<div class="log-date-row">`;
    html += `<input type="date" data-log-input="${item.id}" value="${logDateValue}" />`;
    html += `<button class="btn-save" style="background:${cat.color}" onclick="saveLog('${item.id}')">Save</button>`;
    html += `<button class="btn-icon" onclick="cancelLog()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>`;
    html += `</div>`;
  }

  if (isOpen) {
    html += `<div class="expanded-panel">`;
    html += renderIntervalChart(item, cat.color);

    if (item.history.length === 0) {
      html += `<p class="no-history">No entries yet — log a date to start tracking.</p>`;
    } else {
      html += `<ul class="history-list">`;
      item.history.forEach((d) => {
        html += `<li class="history-item">`;
        html += `<span class="history-date"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#A89E90" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg> ${fmtDate(d)}</span>`;
        html += `<button class="btn-icon" onclick="deleteEntry('${item.id}','${d}')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>`;
        html += `</li>`;
      });
      html += `</ul>`;
    }

    html += `<div class="item-actions">`;
    if (movingItem === item.id) {
      html += `<div class="move-row"><span style="color:#A89E90">Move to:</span>`;
      state.categories.filter((c) => c.id !== item.categoryId).forEach((c) => {
        html += `<button class="move-pill" onclick="moveItem('${item.id}','${c.id}')">${escapeHtml(c.name)}</button>`;
      });
      html += `<button class="btn-icon" onclick="cancelMove()"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>`;
      html += `</div>`;
    } else {
      html += `<button class="link-btn" onclick="startMove('${item.id}')">Move to another group</button>`;
      html += `<button class="link-btn danger" onclick="deleteItem('${item.id}')">Delete</button>`;
    }
    html += `</div>`;

    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function renderCategory(cat) {
  const catItems = state.items.filter((it) => it.categoryId === cat.id);

  let html = `<section>`;
  html += `<div class="cat-header">`;
  html += `<div class="cat-icon" style="background:${cat.color}1A">${cat.icon}</div>`;
  html += `<h2 class="cat-title">${escapeHtml(cat.name)}</h2>`;
  html += `<span class="cat-count">${catItems.length}</span>`;
  html += `</div>`;

  if (catItems.length === 0) {
    html += `<p class="empty-msg">Nothing here yet.</p>`;
  } else {
    catItems.forEach((item) => {
      html += renderItem(item, cat);
    });
  }

  if (addingTo === cat.id) {
    html += `<div class="add-item-row">`;
    html += `<input type="text" data-add-input="${cat.id}" placeholder="e.g. AC servicing" onkeydown="if(event.key==='Enter') addItem('${cat.id}')" />`;
    html += `<button class="btn-save" style="background:${cat.color}" onclick="addItem('${cat.id}')">Add</button>`;
    html += `<button class="btn-icon" onclick="cancelAdd()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>`;
    html += `</div>`;
  } else {
    html += `<button class="add-item-btn" onclick="startAdd('${cat.id}')">`;
    html += `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Add item`;
    html += `</button>`;
  }

  html += `</section>`;
  return html;
}

function render() {
  const app = document.getElementById("app");
  let html = "";
  state.categories.forEach((cat) => {
    html += renderCategory(cat);
  });
  html += `<p class="footer-note">${settings.storageMode === "drive" ? "Synced with your Google Drive." : "Your data is saved on this device."}</p>`;
  app.innerHTML = html;
  renderSyncStatus();
}

// ============================================================
// INIT
// ============================================================
render();
initGoogleClient();
