/* PhilGeps BidOps Matcher - scanner.js
 * DOM extraction of opportunity rows, stable unique-id generation for
 * deduplication, and low-overhead detection of when the visible listing
 * has changed (tab switch, pagination, dynamic reload, SPA navigation).
 */

var PBOM_ROW_ID_ATTR = "data-pbom-id";

function pbomNormalizeWhitespace(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- Table / row detection ------------------------------------------------

function pbomScoreTableAsOpportunityTable(table) {
  const headerRow = pbomFindTableHeaderRow(table);
  if (!headerRow) return 0;
  const headerCells = Array.from(headerRow.querySelectorAll("th,td"));
  if (headerCells.length === 0) return 0;
  const headerTexts = headerCells.map((c) => pbomNormalizeWhitespace(c.textContent).toLowerCase());

  let score = 0;
  if (headerTexts.some((h) => h.includes("title"))) score += 3;
  if (headerTexts.some((h) => h.includes("publish"))) score += 2;
  if (headerTexts.some((h) => h.includes("closing"))) score += 2;
  if (headerTexts.some((h) => /^no\.?$/.test(h) || h.includes("no."))) score += 1;

  const dataRowCount = table.querySelectorAll("tr").length - 1;
  if (dataRowCount < 1) return 0;

  return score;
}

function pbomFindTableHeaderRow(table) {
  if (!table) return null;
  const rows = Array.from(table.querySelectorAll("thead tr"));
  if (rows.length > 0) return rows[rows.length - 1];
  return table.querySelector("tr");
}

function pbomFindOpportunityTable() {
  const tables = Array.from(document.querySelectorAll("table"));
  let best = null;
  let bestScore = 0;
  tables.forEach((table) => {
    const score = pbomScoreTableAsOpportunityTable(table);
    if (score > bestScore) {
      bestScore = score;
      best = table;
    }
  });
  return bestScore >= 4 ? best : null;
}

function pbomGetHeaderColumnIndexes(table) {
  const headerRow = pbomFindTableHeaderRow(table);
  const headerCells = Array.from(headerRow.querySelectorAll("th,td"));
  const headerTexts = [];
  let column = 0;
  headerCells.forEach((cell) => {
    const text = pbomNormalizeWhitespace(cell.textContent).toLowerCase();
    const span = Math.max(1, parseInt(cell.getAttribute("colspan") || "1", 10) || 1);
    for (let i = 0; i < span; i++) headerTexts[column++] = text;
  });

  const findIdx = (predicate) => headerTexts.findIndex(predicate);

  return {
    no: findIdx((h) => /^no\.?$/.test(h) || h.includes("no.")),
    publish: findIdx((h) => h.includes("publish")),
    closing: findIdx((h) => h.includes("closing")),
    title: findIdx((h) => h.includes("title")),
    category: findIdx((h) => h.includes("category") || h.includes("classification")),
    entity: findIdx((h) => h.includes("procuring entity") || h.includes("entity") || h.includes("agency")),
    location: findIdx(
      (h) => h.includes("area of delivery") || h.includes("location") || h.includes("delivery area") || h.includes("region")
    ),
    reference: findIdx((h) => h.includes("reference") || h.includes("solicitation")),
    headerRowEl: headerRow,
  };
}

function pbomCellRawText(cell) {
  if (!cell) return "";
  return String(cell.innerText != null ? cell.innerText : cell.textContent || "").trim();
}

function pbomTableFieldRole(text) {
  const value = pbomNormalizeWhitespace(text).toLowerCase();
  if (!value) return null;
  if (/(closing|deadline|due\s*date|submission|bid\s*opening|opening\s+of\s+bids|closes?)/i.test(value)) return "closing";
  if (/(publish|posted|posting|issued|publication|date\s+of\s+(issue|posting))/i.test(value)) return "publish";
  if (/(procuring|entity|agency|office|department|end[-\s]?user|requesting)/i.test(value)) return "entity";
  if (/(area\s+of\s+delivery|delivery|location|region|site|place)/i.test(value)) return "location";
  if (/((reference|ref\.?|solicitation|rfq|itb|ifb|bid|tender|control|project)\s*(no\.?|number|#|id)|^reference$|^ref\.?$|^no\.?$|^#$)/i.test(value)) return "reference";
  if (/(category|classification|mode|nature|\btype\b)/i.test(value)) return "category";
  if (/(title|description|project|procurement|particulars|subject|name|item|tender|solicitation|notice|announcement|bid)/i.test(value)) return "title";
  return null;
}

function pbomReadTableField(row, cells, columnIndexes, role) {
  const labeled = cells.find((cell) => {
    const label = cell.getAttribute("data-label") || cell.getAttribute("aria-label") || cell.getAttribute("title") || "";
    return pbomTableFieldRole(label) === role;
  });
  const index = columnIndexes[role];
  const cell = labeled || (index >= 0 ? cells[index] : null);
  return {
    raw: pbomCellRawText(cell),
    value: pbomNormalizeWhitespace(cell ? cell.textContent : ""),
    cell,
  };
}

function pbomExtractOpportunities() {
  const table = pbomFindOpportunityTable();
  if (!table) {
    return { table: null, opportunities: [] };
  }

  const colIdx = pbomGetHeaderColumnIndexes(table);
  const headerCellCount = Array.from(colIdx.headerRowEl.querySelectorAll("th,td")).length;
  const allRows = Array.from(table.querySelectorAll("tr"));
  const dataRows = allRows.filter((r) => r !== colIdx.headerRowEl && r.querySelector("td"));

  const opportunities = [];

  dataRows.forEach((row, idx) => {
    const cells = Array.from(row.querySelectorAll("td"));
    if (cells.length === 0) return;

    if (colIdx.title >= 0) {
      if (cells.length <= colIdx.title) return;
    } else if (cells.length < Math.max(2, headerCellCount - 1)) {
      return;
    }

    const fields = {};
    ["no", "publish", "closing", "title", "category", "entity", "location", "reference"].forEach((role) => {
      fields[role] = pbomReadTableField(row, cells, colIdx, role);
    });

    let titleCellEl = fields.title.cell;
    if (titleCellEl) {
      // Header/data-label mapping is authoritative when present.
    } else {
      let bestAnchorCell = null;
      let bestAnchorLen = 0;
      cells.forEach((cell) => {
        const anchor = cell.querySelector("a");
        if (anchor) {
          const len = pbomNormalizeWhitespace(anchor.textContent).length;
          if (len > bestAnchorLen) {
            bestAnchorLen = len;
            bestAnchorCell = cell;
          }
        }
      });
      if (bestAnchorCell) {
        titleCellEl = bestAnchorCell;
      } else {
        let bestLen = 0;
        cells.forEach((cell) => {
          const len = pbomNormalizeWhitespace(cell.textContent).length;
          if (len > bestLen) {
            bestLen = len;
            titleCellEl = cell;
          }
        });
      }
    }

    if (!titleCellEl) return;

    const titleText = pbomNormalizeWhitespace(titleCellEl.textContent);
    if (!titleText || titleText.length < 5) return;

    if (/^(previous|next|first|last|\d+)$/i.test(titleText)) return;

    // Detail link taken from the row itself (title cell first). Resolved
    // against the page and restricted to http(s); null when none is reliable.
    const url = pbomPickDetailLink(row, titleCellEl, titleText);

    const rowText = pbomNormalizeWhitespace(row.textContent);

    const rowKey = "pbom-row-" + idx;
    row.setAttribute(PBOM_ROW_ID_ATTR, rowKey);

    const opportunity = {
      rowKey,
      no: fields.no.value || String(idx + 1),
      publish: fields.publish.value,
      closing: fields.closing.value,
      title: titleText,
      url,
      rowText,
      category: fields.category.value,
      entity: fields.entity.value,
      locationColumnText: fields.location.value,
      reference: fields.reference.value,
      rawFields: {
        no: fields.no.raw || String(idx + 1),
        title: pbomCellRawText(titleCellEl),
        publish: fields.publish.raw,
        closing: fields.closing.raw,
        category: fields.category.raw,
        entity: fields.entity.raw,
        location: fields.location.raw,
        reference: fields.reference.raw,
      },
      rowEl: row,
      titleCellEl,
    };
    opportunity.uid = pbomComputeOpportunityUid(opportunity);

    opportunities.push(opportunity);
  });

  return { table, opportunities };
}

function pbomFindTotalOpportunitiesCount() {
  const bodyText = document.body ? document.body.innerText : "";
  const patterns = [
    /total\s+records?\s*(?:found)?\s*:?\s*([\d,]+)/i,
    /([\d,]+)\s+records?\s+found/i,
    /showing\s+[\d,]+\s*(?:to|-)\s*[\d,]+\s+of\s+([\d,]+)/i,
  ];
  for (const re of patterns) {
    const m = bodyText.match(re);
    if (m && m[1]) {
      const num = parseInt(m[1].replace(/,/g, ""), 10);
      if (!isNaN(num)) return num;
    }
  }
  return null;
}

// ---- Stable unique id for deduplication ------------------------------------

function pbomSimpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Priority for a stable identifier that survives across pages/tabs/reloads:
 *   1. Canonical opportunity URL (tracking params/fragment removed)
 *   2. Reference/solicitation number column, if present (domain-scoped for
 *      sites other than PhilGEPS so equal numbers on different agencies
 *      don't collide)
 *   3. Hash of title + closing date + procuring entity (+ domain)
 */
function pbomComputeOpportunityUid(op) {
  const canonical = op.url ? pbomCanonicalizeUrl(op.url) : null;
  if (canonical) {
    return "url:" + canonical;
  }
  const domain = pbomGetDomain(window.location.href);
  const scoped = domain && !PBOM_PHILGEPS_HOST_RE.test(domain) ? domain + ":" : "";
  if (op.reference) {
    return "ref:" + scoped + pbomNormalizeWhitespace(op.reference).toUpperCase();
  }
  const composite = [op.title, op.closing, op.entity].map((s) => pbomNormalizeWhitespace(s).toUpperCase()).join("|");
  return "composite:" + pbomSimpleHash(scoped + composite);
}

/**
 * The uid scheme used before URLs were canonicalized. The background uses
 * it to fold records saved by older versions into the new uid instead of
 * creating duplicates (or re-notifying).
 */
function pbomLegacyOpportunityUid(op) {
  if (op.url) return pbomLegacyUrlUid(op.url);
  if (op.reference) return "ref:" + pbomNormalizeWhitespace(op.reference).toUpperCase();
  const composite = [op.title, op.closing, op.entity].map((s) => pbomNormalizeWhitespace(s).toUpperCase()).join("|");
  return "composite:" + pbomSimpleHash(composite);
}

// ---- Page-change observation -----------------------------------------------

/**
 * Watches for signals that the visible opportunity listing may have
 * changed: DOM mutations inside the page content, SPA-style history
 * navigation (pushState/replaceState/popstate), and plain URL polling as a
 * cheap fallback for sites that neither fire popstate nor mutate the DOM
 * predictably. All signals are debounced into a single callback so rapid
 * bursts of changes (e.g. a full re-render) trigger only one rescan.
 *
 * @param {Function} onChange - called (debounced) when a rescan should happen
 * @param {number} debounceMs
 * @param {{characterData?: boolean}} [opts] - characterData=false keeps CPU low on busy non-PhilGEPS pages
 * @returns {Function} stop() — disconnects all observers/listeners
 */
function pbomObservePageChanges(onChange, debounceMs, opts) {
  let timer = null;
  let lastUrl = window.location.href;

  function scheduleRescan() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs || 600);
  }

  // 1) DOM mutations (new rows loading, pagination re-render, tab content swap).
  const observer = new MutationObserver((mutations) => {
    // Ignore mutations that are only our own highlight <mark> churn.
    const meaningful = mutations.some((m) => {
      if (m.type === "characterData") return true;
      const nodes = [...m.addedNodes, ...m.removedNodes];
      return nodes.some((n) => {
        if (n.nodeType !== 1) return true; // text node change is meaningful
        const cls = n.classList;
        return !(cls && (cls.contains("philgeps-bidops-kw-highlight") || cls.contains("philgeps-bidops-loc-highlight")));
      });
    });
    if (meaningful) scheduleRescan();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: !opts || opts.characterData !== false });

  // 2) SPA-style navigation via History API.
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function () {
    const result = origPushState.apply(this, arguments);
    scheduleRescan();
    return result;
  };
  history.replaceState = function () {
    const result = origReplaceState.apply(this, arguments);
    scheduleRescan();
    return result;
  };
  const popStateHandler = () => scheduleRescan();
  window.addEventListener("popstate", popStateHandler);

  // 3) Cheap URL-polling fallback for navigations that don't use the
  //    History API at all (plain link clicks that this content script
  //    survives, e.g. same-document anchor changes on some PhilGEPS pages).
  const urlPollInterval = setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      scheduleRescan();
    }
  }, 1500);

  function stop() {
    observer.disconnect();
    history.pushState = origPushState;
    history.replaceState = origReplaceState;
    window.removeEventListener("popstate", popStateHandler);
    clearInterval(urlPollInterval);
    if (timer) clearTimeout(timer);
  }

  return stop;
}
