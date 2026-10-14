/* PhilGeps BidOps Matcher - universal-extractor.js
 * Site-independent opportunity extraction. scanner.js still owns the
 * PhilGEPS-specific table logic; this file layers a modular strategy chain
 * on top so any accessible government procurement page can be scanned:
 *
 *   1. Site adapters      - optional per-agency extractors (pbomRegisterAdapter)
 *   2. PhilGEPS table     - the original, strict table detector (scanner.js)
 *   3. Generic tables     - header-driven column mapping for ordinary HTML tables
 *   4. Repeated cards     - lists/grids of repeated elements that each carry a link
 *
 * The first strategy that yields opportunities wins. Every strategy returns
 * the same record shape the PhilGEPS path always produced, so matching,
 * location detection, date-window qualification and highlighting are shared.
 *
 * Nothing here invents data: a field that is not on the page stays empty,
 * and a link is only ever taken from an anchor inside the row/card itself.
 * Loaded after scanner.js; uses only `var`/function declarations so a
 * repeated injection into the same page world is harmless.
 */

// ---- Procurement signal ---------------------------------------------------------

var PBOM_PROCUREMENT_SIGNAL_RE =
  /\b(bids?|bidding|bidders?|tenders?|rfq|rfp|rfb|itb|ifb|eoi|invitation\s+(?:to|for)\s+(?:bid|quot\w*|apply)|request\s+for\s+(?:quot\w*|proposals?|bids?|expressions?)|quotations?|procurement|procure(?:ment)?s?|solicitations?|notice\s+of\s+award|public\s+bidding|small\s+value|negotiated|supply\s+and\s+delivery|opportunit(?:y|ies)|purchase\s+(?:request|order)|canvass)\b/i;

function pbomPageProcurementSignal() {
  const parts = [document.title || "", window.location.pathname || "", window.location.hostname || ""];
  document.querySelectorAll("h1, h2").forEach((h, i) => {
    if (i < 6) parts.push(h.textContent || "");
  });
  return PBOM_PROCUREMENT_SIGNAL_RE.test(parts.join(" "));
}

function pbomNearestHeadingText(el) {
  let node = el;
  for (let depth = 0; node && depth < 5; depth++) {
    let sib = node.previousElementSibling;
    for (let hops = 0; sib && hops < 6; hops++, sib = sib.previousElementSibling) {
      if (/^H[1-6]$/.test(sib.tagName) || (sib.className && /title|heading|caption/i.test(String(sib.className)))) {
        return pbomNormalizeWhitespace(sib.textContent).slice(0, 200);
      }
      const inner = sib.querySelector && sib.querySelector("h1,h2,h3,h4,h5,h6");
      if (inner) return pbomNormalizeWhitespace(inner.textContent).slice(0, 200);
    }
    node = node.parentElement;
  }
  return "";
}

// ---- Safe detail-link selection -----------------------------------------------------

var PBOM_NON_DETAIL_LINK_TEXT_RE = /^(print|share|email|tweet|next|previous|prev|first|last|top|back|home|login|log in|sign in|register|\d+|»|«|>|<|…|\.\.\.)$/i;
var PBOM_DETAIL_LINK_TEXT_RE = /\b(view|details?|read more|more info|more|open|see|download|full|notice|document)\b/i;

function pbomResolveAnchor(a) {
  if (!a) return null;
  const rawAttr = (a.getAttribute("href") || "").trim();
  if (!rawAttr || rawAttr.charAt(0) === "#") return null; // in-page / JS-only anchors are not detail links
  // a.href is already resolved against the document's base URL.
  const clean = pbomSanitizeUrl(a.href, window.location.href);
  if (!clean) return null;
  const canonical = pbomCanonicalizeUrl(clean);
  const here = pbomCanonicalizeUrl(window.location.href);
  if (!canonical || canonical === here) return null; // pointing at the listing itself is not a detail link
  const text = pbomNormalizeWhitespace(a.textContent);
  if (PBOM_NON_DETAIL_LINK_TEXT_RE.test(text)) return null;
  return clean;
}

/**
 * Returns the opportunity's own link, or null. Order of trust:
 *   1. an anchor inside the title element
 *   2. an anchor whose text is (part of) the title
 *   3. a "view / details / download" style anchor in the row
 *   4. the only distinct valid link in the row
 * With several unrelated links and no clear winner it returns null instead
 * of guessing; callers then fall back to the genuine listing URL.
 */
function pbomPickDetailLink(rowEl, preferredEl, titleText) {
  if (!rowEl) return null;
  if (preferredEl) {
    const own = preferredEl.tagName === "A" ? [preferredEl] : Array.from(preferredEl.querySelectorAll("a[href]"));
    for (const a of own) {
      const url = pbomResolveAnchor(a);
      if (url) return url;
    }
  }
  const anchors = Array.from(rowEl.querySelectorAll("a[href]"));
  const valid = [];
  anchors.forEach((a) => {
    const url = pbomResolveAnchor(a);
    if (url) valid.push({ a, url, text: pbomNormalizeWhitespace(a.textContent) });
  });
  if (valid.length === 0) return null;

  const t = pbomNormalizeWhitespace(titleText).toLowerCase();
  if (t.length >= 8) {
    const probe = t.slice(0, Math.min(24, t.length));
    const byTitle = valid.find((v) => v.text.length >= 8 && (t.includes(v.text.toLowerCase().slice(0, 24)) || v.text.toLowerCase().includes(probe)));
    if (byTitle) return byTitle.url;
  }
  const byLabel = valid.find((v) => PBOM_DETAIL_LINK_TEXT_RE.test(v.text));
  if (byLabel) return byLabel.url;

  const distinct = Array.from(new Set(valid.map((v) => pbomCanonicalizeUrl(v.url))));
  if (distinct.length === 1) return valid[0].url;
  return null;
}

// ---- Labeled-field parsing (cards) --------------------------------------------------

var PBOM_FIELD_LABELS = {
  closing: /^(closing(\s+date)?(\s*(&|and|\/)\s*time)?|deadline(\s+of\s+submission)?|submission\s+deadline|deadline\s+for\s+submission|date\s+of\s+closing|bid\s+(submission|opening)(\s+date)?|opening\s+of\s+bids|due\s+date|closes?(\s+on)?)$/i,
  publish: /^((date\s+)?(published|posted|issued)(\s+date)?|publication\s+date|posting\s+date|date\s+of\s+(posting|publication)|posted\s+on|published\s+on)$/i,
  reference: /^((reference|ref\.?|solicitation|rfq|itb|ifb|bid|tender|control|project)\s*(no\.?|number|#|id)|reference|solicitation)$/i,
  entity: /^(procuring\s+entity|agency|entity|office|department|end[-\s]?user|requesting\s+office|procuring\s+agency)$/i,
  location: /^(area\s+of\s+delivery|delivery\s+(area|site|location)|location|place\s+of\s+delivery|region|project\s+location)$/i,
  category: /^(category|classification|type|procurement\s+type|mode\s+of\s+procurement|nature\s+of\s+procurement)$/i,
};

function pbomSplitCardLines(el) {
  const raw = el.innerText != null ? el.innerText : el.textContent || "";
  const lines = [];
  String(raw)
    .split(/\n+/)
    .forEach((line) => {
      line.split(/\s*[|•·]\s*/).forEach((part) => {
        const clean = pbomNormalizeWhitespace(part);
        if (clean) lines.push(clean);
      });
    });
  return lines;
}

function pbomLabelKeyFor(label) {
  const norm = pbomNormalizeWhitespace(label).replace(/[:：]\s*$/, "");
  for (const key of Object.keys(PBOM_FIELD_LABELS)) {
    if (PBOM_FIELD_LABELS[key].test(norm)) return key;
  }
  return null;
}

function pbomParseLabeledFields(el) {
  const lines = pbomSplitCardLines(el);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = line.match(/^([A-Za-z][A-Za-z .\/#&-]{1,40}?)\s*[:：]\s*(.+)$/);
    if (m) {
      const key = pbomLabelKeyFor(m[1]);
      if (key && !out[key]) out[key] = m[2].slice(0, 300);
      continue;
    }
    m = line.match(/^([A-Za-z][A-Za-z .\/#&-]{1,40}?)\s*[:：]?$/);
    if (m && lines[i + 1]) {
      const key = pbomLabelKeyFor(m[1]);
      if (key && !out[key] && !pbomLabelKeyFor(lines[i + 1])) {
        out[key] = lines[i + 1].slice(0, 300);
        i++;
      }
    }
  }
  if (!out.closing) {
    const text = lines.join(" ");
    const m = text.match(
      /(?:closing|deadline|closes?|due|until|submission)[^.\n]{0,40}?(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}(?:\s*[-–—,]?\s*\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)?|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}(?:\s*[-–—,]?\s*\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)?)/i
    );
    if (m) out.closing = m[1];
  }
  return out;
}

// ---- Shared record builder ---------------------------------------------------------------

function pbomBuildOpportunityRecord(fields, rowEl, titleEl, index, strategy) {
  const title = pbomNormalizeWhitespace(fields.title);
  const rowText = pbomNormalizeWhitespace(rowEl.textContent).slice(0, 4000);
  const rawFields = fields.rawFields || {
    title: fields.title || "",
    publish: fields.publish || "",
    closing: fields.closing || "",
    category: fields.category || "",
    entity: fields.entity || "",
    location: fields.location || "",
    reference: fields.reference || "",
  };
  const status = fields.procurementStatus || (typeof pbomClassifyProcurementStatus === "function"
    ? pbomClassifyProcurementStatus(rowText, title, fields.url || window.location.href)
    : (typeof PBOM_PROCUREMENT_STATUS !== "undefined" ? PBOM_PROCUREMENT_STATUS.UNVERIFIED : "STATUS UNVERIFIED"));

  const op = {
    rowKey: "pbom-row-" + strategy + "-" + index,
    no: fields.no || String(index + 1),
    publish: fields.publish || "",
    closing: fields.closing || "",
    title,
    url: fields.url || null,
    rowText,
    category: fields.category || "",
    entity: fields.entity || "",
    locationColumnText: fields.location || "",
    reference: fields.reference || "",
    rawFields,
    procurementStatus: status,
    rowEl,
    titleCellEl: titleEl || rowEl,
    strategy,
  };
  rowEl.setAttribute(PBOM_ROW_ID_ATTR, op.rowKey);
  op.uid = pbomComputeOpportunityUid(op);
  op.legacyUid = pbomLegacyOpportunityUid(op);
  return op;
}

// ---- Strategy: generic tables ---------------------------------------------------------------

var PBOM_TABLE_ROLE_RULES = [
  ["closing", /(closing|deadline|due\s*date|submission|bid\s*opening|opening\s*of\s*bids|closes?)/i],
  ["publish", /(publish|posted|posting|issued|date\s*of\s*(issue|posting)|advertis|publication)/i],
  ["entity", /(procuring|entity|agency|office|department|end[-\s]?user|requesting)/i],
  ["location", /(area\s*of\s*delivery|delivery|location|region|site|place)/i],
  ["category", /(category|classification|mode|nature|\btype\b)/i],
  ["reference", /((reference|ref\.?|solicitation|rfq|itb|ifb|bid|tender|control|project)\s*(no\.?|number|#|id)|^reference$|^ref\.?$|^no\.?$|^#$)/i],
  ["title", /(title|description|project|procurement|particulars|subject|name|item|tender|solicitation|notice|announcement|bid)/i],
];

function pbomClassifyHeaderRole(text) {
  const t = pbomNormalizeWhitespace(text).toLowerCase();
  if (!t) return null;
  for (const [role, re] of PBOM_TABLE_ROLE_RULES) {
    if (re.test(t)) return role;
  }
  return null;
}

function pbomTableHeaderRow(table) {
  const rows = Array.from(table.rows || table.querySelectorAll("tr"));
  if (rows.length === 0) return null;
  const withTh = rows.find((r) => r.querySelector("th"));
  return withTh || rows[0];
}

function pbomMapTableColumns(headerRow) {
  const cells = Array.from(headerRow.querySelectorAll("th,td"));
  const roles = {};
  let column = 0;
  cells.forEach((c) => {
    const role = pbomClassifyHeaderRole(c.textContent);
    const span = Math.max(1, parseInt(c.getAttribute("colspan") || "1", 10) || 1);
    if (role && !(role in roles)) roles[role] = column;
    column += span;
  });
  return { roles, cells };
}

function pbomExtractGenericTables(pageSignal) {
  const out = [];
  const tables = Array.from(document.querySelectorAll("table")).slice(0, 40);
  let tableIndex = 0;

  tables.forEach((table) => {
    const headerRow = pbomTableHeaderRow(table);
    if (!headerRow) return;
    const { roles, cells: headerCells } = pbomMapTableColumns(headerRow);
    const hasTitle = "title" in roles;
    const supporting = ["closing", "publish", "reference", "entity"].filter((r) => r in roles).length;
    if (!hasTitle || supporting < 1) return;

    const allRows = Array.from(table.rows || table.querySelectorAll("tr"));
    const dataRows = allRows.filter((r) => r !== headerRow && r.querySelector("td"));
    if (dataRows.length < 1) return;

    // Procurement gating: header/caption/nearby heading/page must speak
    // procurement, or most rows individually must.
    const caption = table.caption ? table.caption.textContent : "";
    const context = [headerCells.map((c) => c.textContent).join(" "), caption, pbomNearestHeadingText(table)].join(" ");
    const tableSignal = pageSignal || PBOM_PROCUREMENT_SIGNAL_RE.test(context);
    if (!tableSignal) {
      const hits = dataRows.filter((r) => PBOM_PROCUREMENT_SIGNAL_RE.test(r.textContent || "")).length;
      if (hits / dataRows.length < 0.5) return;
    }

    const idx = tableIndex++;
    dataRows.forEach((row, rIdx) => {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 2) return;
      const cellText = (role) => pbomReadTableField(row, cells, roles, role).value;
      const rawCellText = (role) => pbomReadTableField(row, cells, roles, role).raw;

      let titleCell = cells[roles.title] || null;
      if (!titleCell || pbomNormalizeWhitespace(titleCell.textContent).length < 5) {
        // Mapped column empty/short on this row: fall back to the longest cell.
        titleCell = cells.reduce((best, c) => {
          const len = pbomNormalizeWhitespace(c.textContent).length;
          return !best || len > pbomNormalizeWhitespace(best.textContent).length ? c : best;
        }, null);
      }
      const title = pbomNormalizeWhitespace(titleCell.textContent);
      if (title.length < 5 || /^(previous|next|first|last|\d+)$/i.test(title)) return;

      const record = pbomBuildOpportunityRecord(
        {
          title,
          publish: cellText("publish"),
          closing: cellText("closing"),
          category: cellText("category"),
          entity: cellText("entity"),
          location: cellText("location"),
          reference: cellText("reference"),
          rawFields: {
            title: pbomCellRawText(titleCell),
            publish: rawCellText("publish"),
            closing: rawCellText("closing"),
            category: rawCellText("category"),
            entity: rawCellText("entity"),
            location: rawCellText("location"),
            reference: rawCellText("reference"),
          },
          url: pbomPickDetailLink(row, titleCell, title),
        },
        row,
        titleCell,
        idx * 1000 + rIdx,
        "table"
      );
      out.push(record);
    });
  });
  return out;
}

// ---- Strategy: repeated cards / list items ------------------------------------------------

function pbomElementSignature(el) {
  const classes = Array.from(el.classList || [])
    .filter((c) => !/^(active|selected|current|odd|even|first|last|hover|open|show|hidden)$/i.test(c))
    .sort()
    .join(".");
  return el.tagName + "." + classes;
}

function pbomIsVisible(el) {
  return !!(el.getClientRects && el.getClientRects().length > 0);
}

function pbomFindItemElement(anchor) {
  let el = anchor;
  for (let depth = 0; depth < 6; depth++) {
    const parent = el.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) return null;
    const sig = pbomElementSignature(el);
    let same = 0;
    for (const sib of parent.children) {
      if (pbomElementSignature(sib) === sig) same++;
    }
    if (same >= 3) {
      const len = pbomNormalizeWhitespace(el.textContent).length;
      if (len >= 20 && len <= 1800) return el;
      if (len > 1800) return null;
    }
    el = parent;
  }
  return null;
}

function pbomExtractCardOpportunities(pageSignal) {
  const out = [];
  const anchors = Array.from(document.querySelectorAll("a[href]")).slice(0, 2500);
  const groups = new Map(); // parent element -> Set(item elements)

  anchors.forEach((a) => {
    const text = pbomNormalizeWhitespace(a.textContent);
    if (text.length < 8) return;
    if (a.closest("nav, header, footer, aside, [role='navigation'], [role='banner'], [role='contentinfo'], [role='menu']")) return;
    if (!pbomIsVisible(a)) return;
    const item = pbomFindItemElement(a);
    if (!item) return;
    const parent = item.parentElement;
    if (!groups.has(parent)) groups.set(parent, new Set());
    groups.get(parent).add(item);
  });

  let groupIndex = 0;
  groups.forEach((itemSet) => {
    const items = Array.from(itemSet);
    if (items.length < 3) return;

    const parsed = items.map((item) => ({ item, fields: pbomParseLabeledFields(item), text: item.textContent || "" }));
    const withSignal = parsed.filter((p) => PBOM_PROCUREMENT_SIGNAL_RE.test(p.text)).length;
    const withStructure = parsed.filter((p) => p.fields.closing || p.fields.reference || p.fields.publish).length;
    const signalOk = withSignal / parsed.length >= 0.5 || (pageSignal && withStructure / parsed.length >= 0.5);
    if (!signalOk) return;

    const gIdx = groupIndex++;
    parsed.forEach((p, i) => {
      const item = p.item;
      const heading = item.querySelector("h1,h2,h3,h4,h5,h6,[class*='title' i],[class*='heading' i]");
      let titleEl = heading && pbomNormalizeWhitespace(heading.textContent).length >= 5 ? heading : null;
      if (!titleEl) {
        let best = null;
        let bestLen = 0;
        item.querySelectorAll("a[href]").forEach((a) => {
          const len = pbomNormalizeWhitespace(a.textContent).length;
          if (len > bestLen) {
            bestLen = len;
            best = a;
          }
        });
        titleEl = best;
      }
      if (!titleEl) return;
      const title = pbomNormalizeWhitespace(titleEl.textContent);
      if (title.length < 8) return;

      const url = pbomPickDetailLink(item, titleEl, title);
      out.push(
        pbomBuildOpportunityRecord(
          {
            title,
            publish: p.fields.publish,
            closing: p.fields.closing,
            category: p.fields.category,
            entity: p.fields.entity,
            location: p.fields.location,
            reference: p.fields.reference,
            url,
          },
          item,
          titleEl,
          gIdx * 1000 + i,
          "cards"
        )
      );
    });
  });
  return out;
}

// ---- Adapter registry (future agency-specific extractors) -----------------------------------

var PBOM_SITE_ADAPTERS = [];

/**
 * Register an agency-specific extractor without touching the core pipeline.
 * @param {{name: string, match: function(Location): boolean, extract: function(): Array}} adapter
 *   extract() must return records shaped like pbomBuildOpportunityRecord()'s output.
 */
function pbomRegisterAdapter(adapter) {
  if (adapter && typeof adapter.match === "function" && typeof adapter.extract === "function") {
    PBOM_SITE_ADAPTERS.push(adapter);
  }
}

// ---- Public entry point ------------------------------------------------------------------------

function pbomDedupeByUid(list) {
  const seen = new Set();
  return list.filter((op) => {
    if (seen.has(op.uid)) return false;
    seen.add(op.uid);
    return true;
  });
}

/**
 * Runs the strategy chain against the current document.
 * @returns {{ strategy: string|null, structureFound: boolean, opportunities: Array }}
 */
function pbomExtractUniversal() {
  const cap = (list) => pbomDedupeByUid(list).slice(0, PBOM_MAX_OPPORTUNITIES_PER_SCAN);

  for (const adapter of PBOM_SITE_ADAPTERS) {
    try {
      if (adapter.match(window.location)) {
        const found = adapter.extract() || [];
        if (found.length > 0) return { strategy: "adapter:" + adapter.name, structureFound: true, opportunities: cap(found) };
      }
    } catch (e) {
      /* a faulty adapter must never break scanning */
    }
  }

  // The strict PhilGEPS detector is trusted on PhilGEPS itself. Elsewhere it
  // only wins for tables that carry the same publish AND closing headers
  // (score >= 6); anything weaker goes to the generic, wider-vocabulary
  // table strategy so columns like "Deadline of Submission" aren't lost.
  const phil = pbomExtractOpportunities();
  const philTrusted = phil.table && (pbomIsPhilgepsUrl(window.location.href) || pbomScoreTableAsOpportunityTable(phil.table) >= 6);
  if (philTrusted && phil.opportunities.length > 0) {
    phil.opportunities.forEach((op) => {
      op.legacyUid = pbomLegacyOpportunityUid(op);
      op.strategy = "philgeps-table";
    });
    return { strategy: "philgeps-table", structureFound: true, opportunities: cap(phil.opportunities) };
  }


// ---- Strategy: generic text fallback --------------------------------------------------------

function pbomExtractGenericTextOpportunities(pageSignal) {
  const out = [];
  const items = Array.from(document.querySelectorAll("main li, main p, article p, section li, section p, .content li, .content p, div > li")).slice(0, 60);
  let index = 0;

  items.forEach((item) => {
    const text = pbomNormalizeWhitespace(item.textContent || "");
    if (text.length < 25 || text.length > 2000) return;
    if (!PBOM_PROCUREMENT_SIGNAL_RE.test(text)) return;

    const heading = item.querySelector("strong, b, a, h4, h5, h6");
    const title = heading ? pbomNormalizeWhitespace(heading.textContent) : text.slice(0, 100);
    if (title.length < 8) return;

    const fields = pbomParseLabeledFields(item);
    const a = item.querySelector("a[href]");
    const url = a ? pbomResolveAnchor(a) : null;
    const ref = fields.reference || (typeof pbomExtractReferenceNumber === "function" ? pbomExtractReferenceNumber(text) : "");

    out.push(
      pbomBuildOpportunityRecord(
        {
          title,
          publish: fields.publish || "",
          closing: fields.closing || "",
          category: fields.category || "Procurement Notice",
          entity: fields.entity || "",
          location: fields.location || "",
          reference: ref,
          url,
        },
        item,
        heading || item,
        index++,
        "generic-text"
      )
    );
  });
  return out;
}

  const pageSignal = pbomPageProcurementSignal();

  const tableOps = pbomExtractGenericTables(pageSignal);
  if (tableOps.length > 0) return { strategy: "table", structureFound: true, opportunities: cap(tableOps) };

  const cardOps = pbomExtractCardOpportunities(pageSignal);
  if (cardOps.length > 0) return { strategy: "cards", structureFound: true, opportunities: cap(cardOps) };

  // Layer 3: Downloadable Document Links Adapter
  if (typeof pbomDocumentListAdapter !== "undefined") {
    try {
      const docOps = pbomDocumentListAdapter.extract();
      if (docOps && docOps.length > 0) return { strategy: "document-links", structureFound: true, opportunities: cap(docOps) };
    } catch (e) {}
  }

  // Layer 2: Article and Announcement Adapter
  if (typeof pbomArticleAnnouncementAdapter !== "undefined") {
    try {
      const artOps = pbomArticleAnnouncementAdapter.extract();
      if (artOps && artOps.length > 0) return { strategy: "articles", structureFound: true, opportunities: cap(artOps) };
    } catch (e) {}
  }

  // Fallback: Generic DOM text blocks
  if (pageSignal) {
    const textOps = pbomExtractGenericTextOpportunities(pageSignal);
    if (textOps && textOps.length > 0) return { strategy: "generic-text", structureFound: true, opportunities: cap(textOps) };
  }

  return { strategy: null, structureFound: false, opportunities: [] };
}
