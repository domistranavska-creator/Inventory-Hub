const SHEET_ITEMS = "Items";
const SHEET_RECORDS = "Records";
const KROS_API_BASE_URL = "https://api-economy.kros.sk/api";
const KROS_SYNC_MINUTES = 10;
const GL_INVENTORY_API_URL = "https://script.google.com/macros/s/AKfycbxv9B4OFFtTTEKWAUF_L5sB1AJiBEIlcujZ_A4Zm7yOHr93iGGyVyENQ8TluA8Eh6-t4g/exec";

function runSyncKrosItems() {
  return syncItemsFromKros_();
}

function runSyncGlLocations() {
  return syncLocationsFromGlInventory_();
}

function doGet(e) {
  const action = getAction_(e);

  if (action === "getItems") {
    return jsonResponse_({ items: getItems_() });
  }

  if (action === "getVan") {
    return jsonResponse_({ van: getRecords_() });
  }

  if (action === "syncKrosItems") {
    return jsonResponse_({
      ok: true,
      synced: syncItemsFromKros_()
    });
  }

  if (action === "syncGlLocations") {
    return jsonResponse_({
      ok: true,
      synced: syncLocationsFromGlInventory_()
    });
  }

  return jsonResponse_({
    error: "Unknown action",
    action: action || ""
  });
}

function doPost(e) {
  const action = getAction_(e);
  const payload = parseBody_(e);

  if (action === "saveVan") {
    const incoming = Array.isArray(payload.van) ? payload.van : [];
    saveRecords_(incoming);
    return jsonResponse_({
      ok: true,
      van: getRecords_()
    });
  }

  return jsonResponse_({
    error: "Unknown action",
    action: action || ""
  });
}

function getItems_() {
  const sheet = getRequiredSheet_(SHEET_ITEMS);
  const rows = getSheetObjects_(sheet);

  return rows
    .map((row) => ({
      sku: readText_(row, ["sku", "code", "item code", "article number", "art. no."]),
      name: readText_(row, ["name", "item name"]),
      stockQty: readNumber_(row, ["stockqty", "stock qty", "quantity", "qty", "kros qty", "kros stock"]),
      ltQty: readNumber_(row, ["ltqty", "lt qty"]),
      prQty: readNumber_(row, ["prqty", "pr qty"])
    }))
    .filter((item) => item.sku);
}

function getRecords_() {
  const sheet = getRequiredSheet_(SHEET_RECORDS);
  const rows = getSheetObjects_(sheet);

  return rows
    .map((row) => ({
      sku: readText_(row, ["sku"]),
      location: readText_(row, ["location"]),
      vanQty: readNumber_(row, ["vanqty", "van qty", "qty"]),
      name: readText_(row, ["name"])
    }))
    .filter((record) => record.sku);
}

function syncItemsFromKros_() {
  const token = getKrosToken_();
  if (!token) {
    throw new Error('Missing script property "KROS_TOKEN"');
  }

  const items = fetchAllKrosCatalogItems_(token);
  const sheet = getOrCreateSheet_(SHEET_ITEMS);
  ensureHeaders_(sheet, ["sku", "name", "stockQty", "ltQty", "prQty"]);
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 5).clearContent();

  if (items.length) {
    const values = items.map((item) => [item.sku, item.name, item.stockQty, item.ltQty, item.prQty]);
    sheet.getRange(2, 1, values.length, 5).setValues(values);
  }

  PropertiesService.getScriptProperties().setProperty("KROS_LAST_SYNC_AT", String(Date.now()));
  return items.length;
}

function fetchAllKrosCatalogItems_(token) {
  const results = [];
  const top = 100;
  const overlap = 10;
  let skip = 0;
  let page = 0;

  while (true) {
    const parsed = fetchKrosPageWithRetry_(token, top, skip);
    const batch = extractArrayPayload_(parsed)
      .map(mapKrosCatalogItem_)
      .filter((item) => item.sku);

    page += 1;
    Logger.log(
      "KROS page %s skip=%s top=%s batch=%s unique=%s",
      page,
      skip,
      top,
      batch.length,
      dedupeKrosItems_(batch).length
    );

    results.push.apply(results, batch);

    if (batch.length < top) {
      break;
    }

    skip += (top - overlap);
    Utilities.sleep(350);
  }

  const deduped = dedupeKrosItems_(results);
  Logger.log("KROS sync total raw=%s unique=%s", results.length, deduped.length);
  return deduped;
}

function fetchKrosPageWithRetry_(token, top, skip) {
  const url = KROS_API_BASE_URL + "/catalog-items?top=" + top + "&skip=" + skip;
  const maxAttempts = 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = UrlFetchApp.fetch(url, {
      method: "get",
      muteHttpExceptions: true,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json"
      }
    });

    const status = response.getResponseCode();
    const body = response.getContentText();

    if (status >= 200 && status < 300) {
      return JSON.parse(body);
    }

    if (status === 429 && attempt < maxAttempts) {
      Utilities.sleep(1000 * attempt);
      continue;
    }

    throw new Error("KROS API error " + status + ": " + body);
  }

  throw new Error("KROS API retry failed.");
}

function extractArrayPayload_(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && Array.isArray(payload.items)) {
    return payload.items;
  }

  if (payload && Array.isArray(payload.data)) {
    return payload.data;
  }

  if (payload && Array.isArray(payload.value)) {
    return payload.value;
  }

  return [];
}

function mapKrosCatalogItem_(item) {
  const warehouses = item && item.warehouses && item.warehouses.length
    ? item.warehouses
    : [];
  const warehouseQty = warehouses.reduce(function(sum, warehouse) {
    return sum + Number(warehouse.quantityOnHand || 0);
  }, 0);
  const ltQty = warehouses.reduce(function(sum, warehouse) {
    return safeTrim_(warehouse.code) === "LT"
      ? sum + Number(warehouse.quantityOnHand || 0)
      : sum;
  }, 0);
  const prQty = warehouses.reduce(function(sum, warehouse) {
    return safeTrim_(warehouse.code) === "PR"
      ? sum + Number(warehouse.quantityOnHand || 0)
      : sum;
  }, 0);

  return {
    sku: safeTrim_(
      item && (
        item.itemCode ||
        item.code ||
        item.sku
      )
    ),
    name: safeTrim_(
      item && (
        item.name ||
        item.itemName ||
        item.description
      )
    ),
    stockQty: toPositiveInt_(
      item && (
        item.quantityOnHand ||
        item.quantityInStock ||
        item.quantity ||
        item.stockQty ||
        item.amount ||
        warehouseQty
      )
    ),
    ltQty: toPositiveInt_(ltQty),
    prQty: toPositiveInt_(prQty)
  };
}

function syncLocationsFromGlInventory_() {
  const response = UrlFetchApp.fetch(GL_INVENTORY_API_URL, {
    method: "get",
    muteHttpExceptions: true,
    headers: {
      Accept: "application/json"
    }
  });

  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error("GL Inventory API error " + status + ": " + body);
  }

  const parsed = JSON.parse(body);
  const sourceRows = Array.isArray(parsed && parsed.data)
    ? parsed.data
    : Array.isArray(parsed && parsed.rows)
      ? parsed.rows
      : Array.isArray(parsed)
        ? parsed
        : [];

  const locationsBySku = {};
  sourceRows.forEach(function(row) {
    const sku = safeTrim_(row && (row["Item Code"] || row.itemCode || row.sku));
    const location = safeTrim_(row && (row["Shelf"] || row.shelf || row.location));
    const name = safeTrim_(row && (row["Item Name"] || row.name));

    if (!sku) {
      return;
    }

    locationsBySku[sku] = {
      sku: sku,
      location: location,
      name: name
    };
  });

  const existing = getRecords_();
  const recordMap = {};

  existing.forEach(function(record) {
    recordMap[record.sku] = {
      sku: record.sku,
      location: record.location,
      vanQty: record.vanQty,
      name: record.name
    };
  });

  Object.keys(locationsBySku).forEach(function(sku) {
    const existingRecord = recordMap[sku] || {
      sku: sku,
      location: "",
      vanQty: 0,
      name: ""
    };

    existingRecord.location = locationsBySku[sku].location;
    if (!existingRecord.name && locationsBySku[sku].name) {
      existingRecord.name = locationsBySku[sku].name;
    }

    recordMap[sku] = existingRecord;
  });

  const merged = Object.keys(recordMap)
    .sort()
    .map(function(sku) { return recordMap[sku]; });

  saveRecords_(merged);
  return Object.keys(locationsBySku).length;
}

function dedupeKrosItems_(items) {
  const map = {};

  items.forEach(function(item) {
    if (!item.sku) {
      return;
    }

    if (!map[item.sku]) {
      map[item.sku] = item;
      return;
    }

    if (!map[item.sku].name && item.name) {
      map[item.sku].name = item.name;
    }

    if (!map[item.sku].stockQty && item.stockQty) {
      map[item.sku].stockQty = item.stockQty;
    }

    if (!map[item.sku].ltQty && item.ltQty) {
      map[item.sku].ltQty = item.ltQty;
    }

    if (!map[item.sku].prQty && item.prQty) {
      map[item.sku].prQty = item.prQty;
    }
  });

  return Object.keys(map)
    .sort()
    .map(function(key) { return map[key]; });
}

function saveRecords_(records) {
  const sheet = getOrCreateSheet_(SHEET_RECORDS);
  ensureHeaders_(sheet, ["sku", "location", "vanQty", "name"]);

  const cleanRecords = records
    .map((record) => ({
      sku: safeTrim_(record && record.sku),
      location: safeTrim_(record && record.location),
      vanQty: toPositiveInt_(record && (record.vanQty != null ? record.vanQty : record.qty)),
      name: safeTrim_(record && record.name)
    }))
    .filter((record) => record.sku);

  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 4).clearContent();

  if (!cleanRecords.length) {
    return;
  }

  const values = cleanRecords.map((record) => [
    record.sku,
    record.location,
    record.vanQty,
    record.name
  ]);

  sheet.getRange(2, 1, values.length, 4).setValues(values);
}

function getSheetObjects_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow < 2 || lastColumn < 1) {
    return [];
  }

  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map((header) => normalizeHeader_(header));
  const values = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();

  return values.map((row) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = row[index];
    });
    return obj;
  });
}

function ensureHeaders_(sheet, headers) {
  const lastColumn = Math.max(sheet.getLastColumn(), headers.length);
  const current = lastColumn > 0
    ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    : [];

  const normalizedCurrent = current.map((header) => normalizeHeader_(header));
  const needsReset = headers.some((header, index) => normalizedCurrent[index] !== normalizeHeader_(header));

  if (needsReset) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

function getRequiredSheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) {
    throw new Error('Missing sheet "' + name + '"');
  }
  return sheet;
}

function getKrosToken_() {
  return safeTrim_(PropertiesService.getScriptProperties().getProperty("KROS_TOKEN"));
}

function getOrCreateSheet_(name) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function getAction_(e) {
  return e && e.parameter && e.parameter.action ? String(e.parameter.action) : "";
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return {};
  }

  return JSON.parse(e.postData.contents);
}

function readText_(row, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const key = normalizeHeader_(keys[i]);
    if (row[key] != null && String(row[key]).trim()) {
      return String(row[key]).trim();
    }
  }

  return "";
}

function readNumber_(row, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const key = normalizeHeader_(keys[i]);
    const value = row[key];
    if (value == null || value === "") {
      continue;
    }

    return toPositiveInt_(value);
  }

  return 0;
}

function normalizeHeader_(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function safeTrim_(value) {
  return String(value || "").trim();
}

function toPositiveInt_(value) {
  const parsed = parseInt(value, 10);
  return isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
