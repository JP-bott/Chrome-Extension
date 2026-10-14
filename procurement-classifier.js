/* PhilGeps BidOps Matcher - procurement-classifier.js
 * Non-AI procurement context classification, status recognition, and
 * document-link discovery. Shared across content scripts, background worker,
 * and test suites.
 * Depends on: constants.js (PBOM_PROCUREMENT_STATUS, PBOM_HIGHLIGHT_TYPES)
 */

var PBOM_DOC_EXT_RE = /\.(pdf|docx?|xlsx?|csv|zip|rar)($|[?#])/i;
var PBOM_DOC_PATH_RE = /(?:download|attachment|document|viewer|file|uploads?|bids?|procurement)[^"'<>]*?\.(?:pdf|docx?|xlsx?)/i;

var PBOM_LOCAL_PROC_SIGNAL_RE =
  /\b(bids?|bidding|bidders?|tenders?|rfq|rfp|rfb|itb|ifb|eoi|invitation\s+(?:to|for)\s+(?:bid|quot\w*|apply)|request\s+for\s+(?:quot\w*|proposals?|bids?|expressions?)|quotations?|procurement|procure(?:ment)?s?|solicitations?|notice\s+of\s+award|public\s+bidding|small\s+value|negotiated|supply\s+and\s+delivery|opportunit(?:y|ies)|purchase\s+(?:request|order)|canvass)\b/i;

var PBOM_STATUS_PATTERNS = [
  {
    status: "AWARDED",
    re: /\b(notice\s+of\s+award|\bnoa\b|notice\s+to\s+proceed|\bntp\b|abstract\s+of\s+(?:bids|quotations?)|resolution\s+(?:to\s+award|recommending\s+award)|contract\s+award(?:ed)?|awarded\s+(?:contract|bid)|approved\s+budget\s+for\s+award)\b/i,
  },
  {
    status: "CANCELLED",
    re: /\b(notice\s+of\s+cancellation|failure\s+of\s+bidding|cancelled(?:\s+bid|\s+procurement)?|cancellation\s+notice|terminated|declared\s+failure)\b/i,
  },
  {
    status: "BULLETIN",
    re: /\b(bid\s+bulletin|supplemental\s+bid\s+bulletin|supplemental\s+bulletin|addendum|amendment|bid\s+supplement|clarification\s+bulletin|bulletin\s+no\.?)\b/i,
  },
  {
    status: "APP",
    re: /\b(annual\s+procurement\s+plan|\bapp\b|project\s+procurement\s+management\s+plan|\bppmp\b|indicative\s+app)\b/i,
  },
  {
    status: "UPCOMING",
    re: /\b(pre-procurement(?:\s+conference)?|upcoming\s+procurement|forthcoming\s+bidding|advance\s+procurement\s+notice|early\s+procurement\s+activit(?:y|ies))\b/i,
  },
  {
    status: "CLOSED",
    re: /\b(closed|bidding\s+closed|submission\s+ended|deadline\s+passed|expired\s+opportunity)\b/i,
  },
  {
    status: "ACTIVE",
    re: /\b(invitation\s+to\s+bid|\bitb\b|request\s+for\s+quotations?|\brfq\b|request\s+for\s+proposals?|\brfp\b|open\s+for\s+bidding|canvass(?:ing)?|public\s+bidding|small\s+value\s+procurement|negotiated\s+procurement|submission\s+of\s+bids|bidding\s+documents?)\b/i,
  },
];

function pbomClassifyProcurementStatus(text, title, url) {
  const combined = [title || "", text || "", url || ""].join(" ");
  if (!combined.trim()) {
    return (typeof PBOM_PROCUREMENT_STATUS !== "undefined" && PBOM_PROCUREMENT_STATUS.UNVERIFIED) || "STATUS UNVERIFIED";
  }

  for (const item of PBOM_STATUS_PATTERNS) {
    if (item.re.test(combined)) {
      return (typeof PBOM_PROCUREMENT_STATUS !== "undefined" && PBOM_PROCUREMENT_STATUS[item.status]) || item.status;
    }
  }

  const signalRe = typeof PBOM_PROCUREMENT_SIGNAL_RE !== "undefined" ? PBOM_PROCUREMENT_SIGNAL_RE : PBOM_LOCAL_PROC_SIGNAL_RE;
  if (signalRe.test(combined)) {
    return (typeof PBOM_PROCUREMENT_STATUS !== "undefined" && PBOM_PROCUREMENT_STATUS.UNVERIFIED) || "STATUS UNVERIFIED";
  }

  return (typeof PBOM_PROCUREMENT_STATUS !== "undefined" && PBOM_PROCUREMENT_STATUS.GENERAL) || "GENERAL";
}

function pbomExtractReferenceNumber(text) {
  if (!text) return "";
  // Check structured prefix with word boundaries
  const m = String(text).match(
    /\b(?:Project(?:\s+Ref(?:\.|erence)?)?|Solicitation|Reference|Ref\.?|ITB|RFQ|RFP|\bPR\b|Control|BAC)\s*(?:No\.?|Number|#|ID)?\s*[:：-]?\s*([A-Za-z0-9\/-]{3,35})\b/i
  );
  if (m && m[1] && !/^(the|and|for|with|from|date|project)$/i.test(m[1])) {
    return m[1].trim();
  }
  const m2 = String(text).match(/\b((?:RFQ|ITB|RFP|PR|PB|BAC)-[0-9A-Za-z\/-]{3,25})\b/i);
  if (m2 && m2[1]) {
    return m2[1].trim();
  }
  return "";
}

function pbomCleanFileName(urlStr, linkText) {
  if (linkText && PBOM_DOC_EXT_RE.test(linkText)) {
    return linkText.trim();
  }
  try {
    const u = new URL(urlStr);
    const pathname = u.pathname;
    const segments = pathname.split("/");
    const last = segments[segments.length - 1];
    if (last && PBOM_DOC_EXT_RE.test(last)) {
      return decodeURIComponent(last.replace(/[+]/g, " "));
    }
  } catch (e) {}
  return (linkText || "").trim();
}

function pbomFindProcurementDocumentLinks(containerEl, baseUrl) {
  if (!containerEl || !containerEl.querySelectorAll) return [];
  const anchors = Array.from(containerEl.querySelectorAll("a[href]")).slice(0, 1500);
  const found = [];
  const seenUrls = new Set();

  anchors.forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;

    let absoluteUrl = null;
    try {
      absoluteUrl = typeof pbomSanitizeUrl === "function" ? pbomSanitizeUrl(href, baseUrl || window.location.href) : (baseUrl ? new URL(href, baseUrl).toString() : href);
    } catch (e) {
      return;
    }
    if (!absoluteUrl || seenUrls.has(absoluteUrl)) return;

    const linkText = typeof pbomNormalizeWhitespace === "function" ? pbomNormalizeWhitespace(a.textContent || "") : (a.textContent || "").trim();
    const titleAttr = typeof pbomNormalizeWhitespace === "function" ? pbomNormalizeWhitespace(a.getAttribute("title") || "") : (a.getAttribute("title") || "").trim();
    const surrounding = typeof pbomNormalizeWhitespace === "function" ? pbomNormalizeWhitespace(a.parentElement ? a.parentElement.textContent : "") : "";
    const combined = [linkText, titleAttr, surrounding, absoluteUrl].join(" ");

    const isDocFile = PBOM_DOC_EXT_RE.test(absoluteUrl) || PBOM_DOC_PATH_RE.test(absoluteUrl) || PBOM_DOC_EXT_RE.test(linkText);
    const signalRe = typeof PBOM_PROCUREMENT_SIGNAL_RE !== "undefined" ? PBOM_PROCUREMENT_SIGNAL_RE : PBOM_LOCAL_PROC_SIGNAL_RE;
    const hasProcurementWord = signalRe.test(combined);

    if (isDocFile && (hasProcurementWord || linkText.length >= 8)) {
      seenUrls.add(absoluteUrl);
      const filename = pbomCleanFileName(absoluteUrl, linkText);
      const refNo = pbomExtractReferenceNumber(combined);
      const status = pbomClassifyProcurementStatus(combined, linkText, absoluteUrl);

      found.push({
        anchorEl: a,
        url: absoluteUrl,
        filename,
        title: linkText || titleAttr || filename || "Procurement Document",
        reference: refNo,
        status,
        contextText: combined.slice(0, 500),
      });
    }
  });

  return found;
}

function pbomClassifyHighlightMatch({ keyword, matchedCount, inTitle, inProcurementContext, strongMatch }) {
  let score = 0;
  if (matchedCount > 1) score += (matchedCount - 1) * 3;
  if (inTitle) score += 2;
  if (inProcurementContext) score += 1;
  if (strongMatch) score += 3;

  const types = typeof PBOM_HIGHLIGHT_TYPES !== "undefined" ? PBOM_HIGHLIGHT_TYPES : { DIRECT: "direct", POTENTIAL: "potential", PRIORITY: "priority", OPTIONAL: "optional" };

  if (matchedCount >= 2 || strongMatch) {
    return { highlightType: types.PRIORITY, priorityScore: score };
  }
  if (inProcurementContext || inTitle) {
    return { highlightType: types.POTENTIAL, priorityScore: score };
  }
  return { highlightType: types.DIRECT, priorityScore: score };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PBOM_DOC_EXT_RE,
    PBOM_DOC_PATH_RE,
    PBOM_STATUS_PATTERNS,
    pbomClassifyProcurementStatus,
    pbomExtractReferenceNumber,
    pbomCleanFileName,
    pbomFindProcurementDocumentLinks,
    pbomClassifyHighlightMatch,
  };
}
