// ---------- Data ----------
const STORAGE_KEY = "recurring-log-data-v1";

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

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items) && Array.isArray(parsed.categories)) {
        return parsed;
      }
    }
  } catch (e) {
    console.error("Failed to load state", e);
  }
  return { categories: CATEGORY_PRESETS, items: SEED_ITEMS };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("Failed to save state", e);
  }
}

// UI-only state (not persisted)
let expanded = {};
let addingTo = null;
let newItemName = "";
let logDateFor = null;
let logDateValue = "";
let movingItem = null;

// ---------- Helpers ----------
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

// ---------- Actions ----------
function toggleExpand(id) {
  expanded[id] = !expanded[id];
  render();
}

function startAdd(categoryId) {
  addingTo = categoryId;
  newItemName = "";
  render();
  const input = document.querySelector(`[data-add-input="${categoryId}"]`);
  if (input) input.focus();
}

function cancelAdd() {
  addingTo = null;
  newItemName = "";
  render();
}

function addItem(categoryId) {
  const input = document.querySelector(`[data-add-input="${categoryId}"]`);
  const value = input ? input.value.trim() : "";
  if (!value) return;
  const newItem = { id: String(Date.now()), name: value, categoryId, history: [] };
  state.items.push(newItem);
  saveState();
  addingTo = null;
  render();
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
    saveState();
  }
  logDateFor = null;
  render();
}

function deleteEntry(itemId, dateStr) {
  const item = state.items.find((it) => it.id === itemId);
  if (item) {
    item.history = item.history.filter((d) => d !== dateStr);
    saveState();
  }
  render();
}

function deleteItem(itemId) {
  if (!confirm("Delete this item and all its history?")) return;
  state.items = state.items.filter((it) => it.id !== itemId);
  saveState();
  render();
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
  if (item) {
    item.categoryId = newCategoryId;
    saveState();
  }
  movingItem = null;
  render();
}

// ---------- Rendering ----------
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

  // Row
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

  // Log date row
  if (logDateFor === item.id) {
    html += `<div class="log-date-row">`;
    html += `<input type="date" data-log-input="${item.id}" value="${logDateValue}" />`;
    html += `<button class="btn-save" style="background:${cat.color}" onclick="saveLog('${item.id}')">Save</button>`;
    html += `<button class="btn-icon" onclick="cancelLog()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>`;
    html += `</div>`;
  }

  // Expanded panel
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
  html += `<p class="footer-note">Your data is saved on this device.</p>`;
  app.innerHTML = html;
}

render();
