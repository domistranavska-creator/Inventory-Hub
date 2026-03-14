const WEBAPP_URL = "https://script.google.com/macros/s/AKfycbyXte3FVOOSgv5NEHiEpQVNzwjHFObwzSQBnWZXpjyisjbagI9YnNgElMD284MvVYFc/exec";
const LOCAL_STORAGE_KEY = "inventory_hub_records";
const INVENTORY_LOCAL_STORAGE_KEY = "inventory_hub_catalog";
const RECENT_SKUS_STORAGE_KEY = "inventory_hub_recent_skus";
const LEGACY_LOCAL_STORAGE_KEY = "p_car";
const SYNC_INTERVAL_MS = 20000;
const LOCAL_PROTECT_MS = 60000;
const state = {
  inventory: [],
  records: [],
  syncTimer: null,
  lastRemoteSyncAt: 0,
  lastLocalMutationAt: 0,
  hasPendingLocalChanges: false,
  modalMode: "edit",
  modalSku: "",
  modalName: "",
  recentSkus: []
};

const elements = {};

function byId(id) {
  return document.getElementById(id);
}

function cacheElements() {
  [
    "searchInput", "results", "searchMeta", "syncDot", "syncLabel", "syncMeta",
    "refreshBtn", "exportBtn", "itemCount", "missingLocationCount", "vanQtyCount",
    "vanOnlyToggle", "ltOnlyToggle", "prOnlyToggle",
    "addCustomBtn",
    "mobileSearchBtn", "mobileAddBtn", "mobileVanBtn",
    "recentWrap", "recentList",
    "scrollTopBtn",
    "modalBack", "modalSkuText", "customFields", "customSkuInput", "customNameInput", "locationInput", "qtyInput",
    "confirmBtn", "modalError", "closeModalBtn", "cancelModalBtn", "incQtyBtn", "decQtyBtn"
  ].forEach((id) => {
    elements[id] = byId(id);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeSkuKey(value) {
  const sku = String(value || "").trim();
  if (!/^\d+$/.test(sku)) {
    return sku;
  }

  const normalized = sku.replace(/^0+/, "");
  return normalized || "0";
}

function sanitizeRecord(record) {
  return {
    sku: String(record && record.sku ? record.sku : "").trim(),
    name: String(record && record.name ? record.name : "").trim(),
    location: String(record && record.location ? record.location : "").trim(),
    vanQty: parsePositiveInteger(record && (
      record.vanQty ??
      record.van_qty ??
      record.qty
    ))
  };
}

function sanitizeRecordList(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .map(sanitizeRecord)
    .filter((record) => record.sku);
}

function sanitizeInventoryItem(item) {
  return {
    sku: String(item && (item.sku ?? item.code ?? item["Item Code"]) ? (item.sku ?? item.code ?? item["Item Code"]) : "").trim(),
    name: String(item && (item.name ?? item["Item Name"]) ? (item.name ?? item["Item Name"]) : "").trim(),
    stockQty: parsePositiveInteger(item && (
      item.stockQty ??
      item.stock_qty ??
      item.quantity ??
      item.qty ??
      item["Stock Qty"]
    )),
    ltQty: parsePositiveInteger(item && (
      item.ltQty ??
      item.lt_qty ??
      item["LT Qty"]
    )),
    prQty: parsePositiveInteger(item && (
      item.prQty ??
      item.pr_qty ??
      item["PR Qty"]
    ))
  };
}

function dedupeInventory(items) {
  const map = new Map();

  items.forEach((rawItem) => {
    const item = sanitizeInventoryItem(rawItem);
    if (!item.sku) {
      return;
    }

    const existing = map.get(item.sku);
    if (!existing) {
      map.set(item.sku, {
        sku: item.sku,
        name: item.name || item.sku,
        stockQty: item.stockQty,
        ltQty: item.ltQty,
        prQty: item.prQty
      });
      return;
    }

    if (!existing.name && item.name) {
      existing.name = item.name;
    }

    if (!existing.stockQty && item.stockQty) {
      existing.stockQty = item.stockQty;
    }

    if (!existing.ltQty && item.ltQty) {
      existing.ltQty = item.ltQty;
    }

    if (!existing.prQty && item.prQty) {
      existing.prQty = item.prQty;
    }

  });

  return Array.from(map.values()).sort((a, b) => a.sku.localeCompare(b.sku, undefined, {
    numeric: true,
    sensitivity: "base"
  }));
}

function loadRecords() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      return sanitizeRecordList(JSON.parse(raw));
    }

    const legacyRaw = localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
    if (!legacyRaw) {
      return [];
    }

    const migrated = sanitizeRecordList(JSON.parse(legacyRaw).map((entry) => ({
      ...entry,
      vanQty: entry.qty
    })));
    writeLocalRecords(migrated);
    return migrated;
  } catch (error) {
    console.error("Could not read local records", error);
    return [];
  }
}

function loadInventory() {
  try {
    const raw = localStorage.getItem(INVENTORY_LOCAL_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    return dedupeInventory(JSON.parse(raw));
  } catch (error) {
    console.error("Could not read local inventory", error);
    return [];
  }
}

function writeLocalRecords(list) {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(sanitizeRecordList(list)));
}

function writeLocalInventory(list) {
  localStorage.setItem(INVENTORY_LOCAL_STORAGE_KEY, JSON.stringify(dedupeInventory(list)));
}

function loadRecentSkus() {
  try {
    const raw = localStorage.getItem(RECENT_SKUS_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 6)
      : [];
  } catch (error) {
    console.error("Could not read recent items", error);
    return [];
  }
}

function writeRecentSkus(list) {
  localStorage.setItem(RECENT_SKUS_STORAGE_KEY, JSON.stringify(list.slice(0, 6)));
}

function rememberRecentSku(sku) {
  const cleanSku = String(sku || "").trim();
  if (!cleanSku) {
    return;
  }

  state.recentSkus = [cleanSku, ...state.recentSkus.filter((item) => item !== cleanSku)].slice(0, 6);
  writeRecentSkus(state.recentSkus);
}

function getRecordMap(records = state.records) {
  const map = new Map();

  sanitizeRecordList(records).forEach((record) => {
    const key = normalizeSkuKey(record.sku);
    const existing = map.get(key);
    if (existing) {
      existing.location = record.location || existing.location;
      existing.vanQty = record.vanQty;
      existing.name = record.name || existing.name;
      return;
    }

    map.set(key, { ...record });
  });

  return map;
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "never";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}

function setSyncState(kind, label, meta) {
  elements.syncDot.dataset.state = kind;
  elements.syncLabel.textContent = label;
  elements.syncMeta.textContent = meta;
}

function markLocalMutation() {
  state.lastLocalMutationAt = Date.now();
  state.hasPendingLocalChanges = true;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      ...options,
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

function applyRemoteRecords(remoteRecords, options = {}) {
  const force = Boolean(options.force);
  const tooSoon = Date.now() - state.lastLocalMutationAt < LOCAL_PROTECT_MS;

  if (!force && (state.hasPendingLocalChanges || tooSoon)) {
    return false;
  }

  state.records = sanitizeRecordList(remoteRecords);
  writeLocalRecords(state.records);
  return true;
}

function buildRows() {
  const recordMap = getRecordMap();

  const merged = state.inventory.map((item) => {
    const key = normalizeSkuKey(item.sku);
    const record = recordMap.get(key) || { sku: item.sku, location: "", vanQty: 0, name: "" };
    recordMap.delete(key);

    return {
      sku: item.sku,
      name: item.name || record.name || item.sku,
      stockQty: item.stockQty,
      ltQty: item.ltQty || 0,
      prQty: item.prQty || 0,
      location: record.location || "",
      vanQty: record.vanQty || 0,
      source: "inventory"
    };
  });

  recordMap.forEach((record) => {
    merged.push({
      sku: record.sku,
      name: record.name || record.sku,
      stockQty: 0,
      ltQty: 0,
      prQty: 0,
      location: record.location || "",
      vanQty: record.vanQty || 0,
      source: "record-only"
    });
  });

  return merged.sort((a, b) => a.sku.localeCompare(b.sku, undefined, {
    numeric: true,
    sensitivity: "base"
  }));
}

function getFilteredRows() {
  const query = normalizeText(elements.searchInput.value);
  const vanOnly = Boolean(elements.vanOnlyToggle.checked);
  const ltOnly = Boolean(elements.ltOnlyToggle.checked);
  const prOnly = Boolean(elements.prOnlyToggle.checked);
  const rows = buildRows();

  let filtered = rows.slice();

  if (vanOnly) {
    filtered = filtered.filter((row) => row.vanQty > 0);
  }

  if (ltOnly || prOnly) {
    filtered = filtered.filter((row) => {
      if (ltOnly && prOnly) {
        return row.ltQty > 0 || row.prQty > 0;
      }

      if (ltOnly) {
        return row.ltQty > 0;
      }

      return row.prQty > 0;
    });
  }

  if (!query) {
    const recentSet = new Set(state.recentSkus);
    return filtered.sort((a, b) => {
      const aRecent = recentSet.has(a.sku) ? 1 : 0;
      const bRecent = recentSet.has(b.sku) ? 1 : 0;
      if (aRecent !== bRecent) {
        return bRecent - aRecent;
      }

      return a.sku.localeCompare(b.sku, undefined, {
        numeric: true,
        sensitivity: "base"
      });
    });
  }

  return filtered
    .filter((row) => {
      const haystack = [
        row.sku,
        row.name,
        row.location,
        row.vanQty ? String(row.vanQty) : "",
        row.stockQty ? String(row.stockQty) : "",
        row.ltQty ? String(row.ltQty) : "",
        row.prQty ? String(row.prQty) : ""
      ].map(normalizeText).join(" ");

      return haystack.includes(query);
    });
}

function hasActiveQueryOrFilters() {
  return Boolean(
    elements.searchInput.value.trim() ||
    elements.vanOnlyToggle.checked ||
    elements.ltOnlyToggle.checked ||
    elements.prOnlyToggle.checked
  );
}

function rowStatus(row) {
  if (!row.location && row.vanQty > 0) {
    return { label: "Van only", className: "status-warn" };
  }

  if (!row.location) {
    return { label: "Missing location", className: "status-warn" };
  }

  if (row.vanQty > 0) {
    return { label: "In van", className: "status-ok" };
  }

  return { label: "Shelved", className: "status-neutral" };
}

function stockText(row) {
  return `${row.stockQty || 0} pcs`;
}

function renderRecentItems() {
  if (!elements.recentWrap || !elements.recentList) {
    return;
  }

  const recentRows = state.recentSkus
    .map((sku) => getRowBySku(sku))
    .filter(Boolean)
    .slice(0, 6);

  const shouldShow = recentRows.length > 0 && !elements.searchInput.value.trim() && !elements.vanOnlyToggle.checked && !elements.ltOnlyToggle.checked && !elements.prOnlyToggle.checked;
  elements.recentWrap.classList.toggle("hidden", !shouldShow);

  if (!shouldShow) {
    elements.recentList.innerHTML = "";
    return;
  }

  elements.recentList.innerHTML = recentRows.map((row) => `
    <button class="recent-chip" type="button" data-action="recent-item" data-sku="${escapeHtml(row.sku)}">
      <span class="recent-chip-sku">${escapeHtml(row.sku)}</span>
      <span class="recent-chip-name">${escapeHtml(row.name)}</span>
    </button>
  `).join("");
}


function updateSummary(rows) {
  const allRows = buildRows();
  const missingLocation = allRows.filter((row) => !row.location).length;
  const totalVanQty = allRows.reduce((sum, row) => sum + row.vanQty, 0);
  const query = elements.searchInput.value.trim();
  const vanOnly = Boolean(elements.vanOnlyToggle.checked);
  const ltOnly = Boolean(elements.ltOnlyToggle.checked);
  const prOnly = Boolean(elements.prOnlyToggle.checked);

  elements.itemCount.textContent = `${allRows.length} items`;
  elements.missingLocationCount.textContent = `${missingLocation} without location`;
  elements.vanQtyCount.textContent = `${totalVanQty} pcs in van`;
  if (elements.mobileVanBtn) {
    elements.mobileVanBtn.classList.toggle("is-active", vanOnly);
  }

  if (!state.inventory.length && !state.records.length) {
    elements.searchMeta.textContent = "No items loaded yet. Refresh the data source.";
    return;
  }

  if (!hasActiveQueryOrFilters()) {
    elements.searchMeta.textContent = "";
    return;
  }

  if (!query) {
    const activeFilters = [];
    if (vanOnly) activeFilters.push("Peter's van");
    if (ltOnly) activeFilters.push("Forestry");
    if (prOnly) activeFilters.push("MLW Tools");

    elements.searchMeta.textContent = activeFilters.length
      ? `Showing ${rows.length} items filtered by ${activeFilters.join(", ")}.`
      : `Showing ${rows.length} items from the shared inventory overview.`;
    return;
  }

  elements.searchMeta.textContent = rows.length
    ? `Showing ${rows.length} matches for "${query}".`
    : `Nothing matched "${query}".`;
}

function renderInventory() {
  const rows = getFilteredRows();
  updateSummary(rows);
  renderRecentItems();

  if (!hasActiveQueryOrFilters()) {
    elements.results.innerHTML = `
      <div class="empty-state empty-state-guide">
        <strong>Start with search or a quick action</strong>
        <span>Find by article number, add a custom item, or turn on a filter.</span>
      </div>
    `;
    return;
  }

  if (!rows.length) {
    elements.results.innerHTML = `<div class="empty-state">Nothing matched your search. Try a code, name or location.</div>`;
    return;
  }

  elements.results.innerHTML = rows.map((row) => {
    const status = rowStatus(row);
    const cardClass = row.ltQty > 0 && row.prQty > 0
      ? "item-card-mixed"
      : row.ltQty > 0
        ? "item-card-forestry"
        : row.prQty > 0
          ? "item-card-mlw"
          : "item-card-neutral";
    const storageBlocks = [
      `
        <div class="detail-block detail-stock">
          <span class="detail-label">KROS stock</span>
          <strong>${escapeHtml(stockText(row))}</strong>
        </div>
      `
    ];

    storageBlocks.push(`
      <div class="detail-block detail-location">
        <span class="detail-label">Location</span>
        <strong>${escapeHtml(row.location || "Not set")}</strong>
      </div>
    `);

    storageBlocks.push(`
      <div class="detail-block detail-van">
        <span class="detail-label">Peter's van</span>
        <strong>${escapeHtml(row.vanQty ? `${row.vanQty} pcs` : "0 pcs")}</strong>
      </div>
    `);

    return `
      <article class="item-card ${cardClass}" data-action="open-record" data-sku="${escapeHtml(row.sku)}">
        <div class="item-main">
          <div class="item-topline">
            <div class="sku-chip">${escapeHtml(row.sku)}</div>
            <p class="item-name item-name-inline">${escapeHtml(row.name)}</p>
            <span class="item-status ${status.className}">${escapeHtml(status.label)}</span>
          </div>
          <div class="detail-grid">
            ${storageBlocks.join("")}
          </div>
        </div>
        <div class="item-actions">
          <button class="action-btn action-btn-quick" type="button" data-action="quick-van" data-sku="${escapeHtml(row.sku)}">
            +1 van
          </button>
          <button class="action-btn action-btn-edit" type="button" data-action="edit-record" data-sku="${escapeHtml(row.sku)}">
            Edit
          </button>
          ${row.source === "record-only" ? `
            <button class="action-btn action-btn-remove" type="button" data-action="delete-record" data-sku="${escapeHtml(row.sku)}">
              Delete
            </button>
          ` : ""}
        </div>
      </article>
    `;
  }).join("");
}

function getRowBySku(sku) {
  const key = normalizeSkuKey(sku);
  return buildRows().find((row) => normalizeSkuKey(row.sku) === key) || null;
}

function openModal(row) {
  state.modalMode = "edit";
  state.modalSku = row.sku;
  state.modalName = row.name;
  rememberRecentSku(row.sku);

  elements.modalSkuText.textContent = `${row.sku} - ${row.name}`;
  elements.customFields.classList.add("hidden");
  elements.customSkuInput.value = "";
  elements.customNameInput.value = "";
  elements.locationInput.value = row.location || "";
  elements.qtyInput.value = String(row.vanQty || 0);
  elements.modalError.classList.add("hidden");
  elements.modalError.textContent = "";
  elements.modalBack.classList.remove("hidden");
  elements.modalBack.setAttribute("aria-hidden", "false");
  window.setTimeout(() => {
    elements.locationInput.focus({ preventScroll: true });
    elements.locationInput.select?.();
  }, 80);
}

function openCreateModal() {
  state.modalMode = "custom";
  state.modalSku = "";
  state.modalName = "";

  elements.modalSkuText.textContent = "Custom item";
  elements.customFields.classList.remove("hidden");
  elements.customSkuInput.value = "";
  elements.customNameInput.value = "";
  elements.locationInput.value = "";
  elements.qtyInput.value = "0";
  elements.modalError.classList.add("hidden");
  elements.modalError.textContent = "";
  elements.modalBack.classList.remove("hidden");
  elements.modalBack.setAttribute("aria-hidden", "false");
  window.setTimeout(() => {
    elements.customSkuInput.focus({ preventScroll: true });
    elements.customSkuInput.select?.();
  }, 80);
}

function closeModal() {
  elements.modalBack.classList.add("hidden");
  elements.modalBack.setAttribute("aria-hidden", "true");
}

async function quickAddVan(sku) {
  const row = getRowBySku(sku);
  if (!row) {
    return;
  }

  rememberRecentSku(row.sku);
  const nextRecords = getRecordMap(state.records);
  nextRecords.set(normalizeSkuKey(row.sku), sanitizeRecord({
    sku: row.sku,
    name: row.name,
    location: row.location,
    vanQty: (row.vanQty || 0) + 1
  }));
  await saveRecords(Array.from(nextRecords.values()));
}

function updateScrollTopButton() {
  if (!elements.scrollTopBtn) {
    return;
  }

  elements.scrollTopBtn.classList.toggle("hidden", window.scrollY < 520);
}

function buildRecordPayload() {
  const sku = state.modalMode === "custom"
    ? elements.customSkuInput.value.trim()
    : state.modalSku;
  const name = state.modalMode === "custom"
    ? elements.customNameInput.value.trim()
    : state.modalName;

  return sanitizeRecord({
    sku,
    name,
    location: elements.locationInput.value.trim(),
    vanQty: elements.qtyInput.value
  });
}

async function saveRecords(records) {
  const cleanList = sanitizeRecordList(records);
  state.records = cleanList;
  writeLocalRecords(cleanList);
  markLocalMutation();
  renderInventory();

  setSyncState("warn", "Saving changes...", `Updating shared records at ${formatTime(state.lastLocalMutationAt)}.`);

  try {
    const response = await fetchJson(`${WEBAPP_URL}?action=saveVan`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        van: cleanList.map((record) => ({
          sku: record.sku,
          name: record.name,
          location: record.location,
          vanQty: record.vanQty
        }))
      })
    });

    state.lastRemoteSyncAt = Date.now();
    state.hasPendingLocalChanges = false;

    if (response && Array.isArray(response.van)) {
      applyRemoteRecords(response.van, { force: true });
    }

    setSyncState("ok", "Changes saved", `Shared records updated ${formatTime(state.lastRemoteSyncAt)}.`);
    renderInventory();
  } catch (error) {
    console.error("Save failed", error);
    setSyncState(
      "error",
      "Save failed",
      "Local changes were kept here and will not be overwritten until a successful save."
    );
  }
}

async function submitModal() {
  const payload = buildRecordPayload();
  if (!payload.sku) {
    elements.modalError.textContent = "Missing article number.";
    elements.modalError.classList.remove("hidden");
    return;
  }

  if (state.modalMode === "custom" && !payload.name) {
    elements.modalError.textContent = "Missing item name.";
    elements.modalError.classList.remove("hidden");
    return;
  }

  const nextRecords = getRecordMap(state.records);
  nextRecords.set(normalizeSkuKey(payload.sku), payload);
  rememberRecentSku(payload.sku);

  closeModal();
  await saveRecords(Array.from(nextRecords.values()));
}

async function deleteCustomRecord(sku) {
  const row = getRowBySku(sku);
  if (!row || row.source !== "record-only") {
    return;
  }

  const confirmed = window.confirm(`Delete custom item ${row.sku}?`);
  if (!confirmed) {
    return;
  }

  const nextRecords = getRecordMap(state.records);
  nextRecords.delete(normalizeSkuKey(sku));
  await saveRecords(Array.from(nextRecords.values()));
}

async function syncFromServer(options = {}) {
  const silent = Boolean(options.silent);

  if (!silent) {
    setSyncState("warn", "Refreshing shared data...", "Checking items and saved locations.");
  }

  try {
    const [itemsResult, recordsResult] = await Promise.allSettled([
      fetchJson(`${WEBAPP_URL}?action=getItems`),
      fetchJson(`${WEBAPP_URL}?action=getVan`)
    ]);

    const itemsOk = itemsResult.status === "fulfilled";
    const recordsOk = recordsResult.status === "fulfilled";

    if (!itemsOk && !recordsOk) {
      throw new Error("Both shared endpoints failed.");
    }

    if (itemsOk) {
      const items = Array.isArray(itemsResult.value && itemsResult.value.items) ? itemsResult.value.items : [];
      state.inventory = dedupeInventory(items);
      writeLocalInventory(state.inventory);
    }

    if (recordsOk) {
      const remoteRecords = Array.isArray(recordsResult.value && recordsResult.value.van) ? recordsResult.value.van : [];
      applyRemoteRecords(remoteRecords);
    }

    state.lastRemoteSyncAt = Date.now();

    if (!itemsOk) {
      setSyncState(
        "warn",
        "Catalog temporarily unavailable",
        `Showing cached catalog. Records refreshed ${formatTime(state.lastRemoteSyncAt)}.`
      );
    } else if (!recordsOk) {
      setSyncState(
        "warn",
        "Records temporarily unavailable",
        `Catalog refreshed ${formatTime(state.lastRemoteSyncAt)}. Using saved local records.`
      );
    } else {
      const meta = state.hasPendingLocalChanges
        ? "Remote data refreshed. Local unsaved edits are still protected on this device."
        : `Last refresh ${formatTime(state.lastRemoteSyncAt)}. Catalog: ${state.inventory.length} items.`;

      setSyncState("ok", "Shared data is up to date", meta);
    }

    renderInventory();
  } catch (error) {
    console.error("Sync from server failed", error);
    setSyncState(
      "error",
      "Server unavailable",
      `Using local records only. Last successful refresh ${formatTime(state.lastRemoteSyncAt)}.`
    );
    renderInventory();
  }
}

function exportInventory() {
  const rows = hasActiveQueryOrFilters()
    ? getFilteredRows()
    : buildRows();
  if (!rows.length) {
    window.alert("Nothing is filtered to export right now.");
    return;
  }

  const csvRows = [
    ["AR No.", "Name", "KROS stock", "LT qty", "PR qty", "Location", "Van qty"],
    ...rows.map((row) => [
      row.sku,
      row.name,
      row.stockQty ? String(row.stockQty) : "",
      row.ltQty ? String(row.ltQty) : "0",
      row.prQty ? String(row.prQty) : "0",
      row.location,
      String(row.vanQty)
    ])
  ];

  const csv = csvRows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(";"))
    .join("\n");

  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "inventory_hub.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function startSyncTimer() {
  if (state.syncTimer) {
    window.clearInterval(state.syncTimer);
  }

  state.syncTimer = window.setInterval(() => {
    syncFromServer({ silent: true });
  }, SYNC_INTERVAL_MS);
}

function bindEvents() {
  elements.searchInput.addEventListener("input", renderInventory);
  elements.searchInput.addEventListener("focus", () => {
    document.body.classList.add("search-active");
  });
  elements.searchInput.addEventListener("blur", () => {
    window.setTimeout(() => {
      document.body.classList.remove("search-active");
    }, 120);
  });
  elements.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      elements.searchInput.blur();
    }
  });
  elements.vanOnlyToggle.addEventListener("change", renderInventory);
  elements.ltOnlyToggle.addEventListener("change", renderInventory);
  elements.prOnlyToggle.addEventListener("change", renderInventory);
  elements.scrollTopBtn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  elements.refreshBtn.addEventListener("click", () => syncFromServer());
  elements.exportBtn.addEventListener("click", exportInventory);
  elements.addCustomBtn.addEventListener("click", openCreateModal);
  elements.mobileAddBtn.addEventListener("click", openCreateModal);
  elements.mobileSearchBtn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    window.setTimeout(() => {
      elements.searchInput.focus({ preventScroll: true });
      elements.searchInput.select?.();
    }, 120);
  });
  elements.mobileVanBtn.addEventListener("click", () => {
    elements.vanOnlyToggle.checked = !elements.vanOnlyToggle.checked;
    renderInventory();
  });
  elements.results.addEventListener("click", (event) => {
    const quickButton = event.target.closest("[data-action='quick-van']");
    if (quickButton) {
      quickAddVan(quickButton.dataset.sku);
      return;
    }

    const deleteButton = event.target.closest("[data-action='delete-record']");
    if (deleteButton) {
      deleteCustomRecord(deleteButton.dataset.sku);
      return;
    }

    const button = event.target.closest("[data-action='edit-record']");
    if (button) {
      const row = getRowBySku(button.dataset.sku);
      if (row) {
        openModal(row);
      }
      return;
    }

    const card = event.target.closest("[data-action='open-record']");
    if (card) {
      const row = getRowBySku(card.dataset.sku);
      if (row) {
        elements.searchInput.blur();
        openModal(row);
      }
    }
  });
  elements.recentList.addEventListener("click", (event) => {
    const recentButton = event.target.closest("[data-action='recent-item']");
    if (!recentButton) {
      return;
    }

    const row = getRowBySku(recentButton.dataset.sku);
    if (row) {
      openModal(row);
    }
  });
  elements.closeModalBtn.addEventListener("click", closeModal);
  elements.cancelModalBtn.addEventListener("click", closeModal);
  elements.confirmBtn.addEventListener("click", submitModal);
  elements.incQtyBtn.addEventListener("click", () => {
    elements.qtyInput.value = String(parsePositiveInteger(elements.qtyInput.value) + 1);
  });
  elements.decQtyBtn.addEventListener("click", () => {
    elements.qtyInput.value = String(Math.max(0, parsePositiveInteger(elements.qtyInput.value) - 1));
  });
  elements.modalBack.addEventListener("click", (event) => {
    if (event.target === elements.modalBack) {
      closeModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.modalBack.classList.contains("hidden")) {
      closeModal();
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === LOCAL_STORAGE_KEY) {
      state.records = loadRecords();
      renderInventory();
    }
  });
  window.addEventListener("scroll", updateScrollTopButton, { passive: true });
}

function init() {
  cacheElements();
  state.inventory = loadInventory();
  state.records = loadRecords();
  state.recentSkus = loadRecentSkus();
  bindEvents();
  updateScrollTopButton();
  renderInventory();
  setSyncState("warn", "Starting up...", "Loading shared inventory data.");
  syncFromServer();
  startSyncTimer();
}

init();
