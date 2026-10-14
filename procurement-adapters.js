/* PhilGeps BidOps Matcher - procurement-adapters.js
 * Strategy adapters for different Philippine government procurement website structures.
 * Implements Layer 1 (Structured tables/cards), Layer 2 (Contextual articles/text blocks),
 * and Layer 3 (Document-link discovery) so any agency portal can be scanned.
 * Depends on: constants.js, url-utils.js, procurement-classifier.js
 */

var pbomDocumentListAdapter = {
  name: "document-links",
  match: function (location) {
    return true;
  },
  extract: function () {
    if (typeof pbomFindProcurementDocumentLinks !== "function") return [];
    const docLinks = pbomFindProcurementDocumentLinks(document.body, window.location.href);
    if (!docLinks || docLinks.length === 0) return [];

    const out = [];
    const seenUrls = new Set();
    let index = 0;

    docLinks.forEach((doc) => {
      if (seenUrls.has(doc.url)) return;
      seenUrls.add(doc.url);

      const anchor = doc.anchorEl;
      const rowOrParent = anchor.closest("tr, li, .item, .card, div") || anchor.parentElement || anchor;
      const surroundingText = typeof pbomNormalizeWhitespace === "function" ? pbomNormalizeWhitespace(rowOrParent.textContent || "") : (rowOrParent.textContent || "").trim();

      const dateMatch = surroundingText.match(
        /(?:closing|deadline|due|submission|opening)[^.\n]{0,40}?(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}(?:\s*[-–—,]?\s*\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)?|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}(?:\s*[-–—,]?\s*\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)?)/i
      );
      const closing = dateMatch ? dateMatch[1] : "";

      const pubMatch = surroundingText.match(
        /(?:posted|published|date\s+issued|posting)[^.\n]{0,35}?(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i
      );
      const publish = pubMatch ? pubMatch[1] : "";

      const title = doc.title && doc.title.length >= 8 ? doc.title : doc.filename;
      if (title.length < 5) return;

      if (typeof pbomBuildOpportunityRecord === "function") {
        const record = pbomBuildOpportunityRecord(
          {
            title,
            publish,
            closing,
            category: doc.filename.endsWith(".pdf") ? "PDF Document" : "Procurement Document",
            entity: "",
            location: "",
            reference: doc.reference || "",
            url: doc.url,
            procurementStatus: doc.status || (typeof PBOM_PROCUREMENT_STATUS !== "undefined" ? PBOM_PROCUREMENT_STATUS.ACTIVE : "ACTIVE"),
          },
          rowOrParent,
          anchor,
          index++,
          "document-link"
        );
        record.documentUrl = doc.url;
        record.documentFilename = doc.filename;
        out.push(record);
      }
    });

    return out;
  },
};

var pbomArticleAnnouncementAdapter = {
  name: "article-announcements",
  match: function (location) {
    return true;
  },
  extract: function () {
    const candidates = Array.from(
      document.querySelectorAll("article, [class*=\x27announcement\x27 i], [class*=\x27notice\x27 i], [class*=\x27bulletin\x27 i], [class*=\x27procurement\x27 i], .post, .entry")
    ).slice(0, 50);

    if (candidates.length === 0) return [];
    const out = [];
    let index = 0;

    candidates.forEach((el) => {
      const text = typeof pbomNormalizeWhitespace === "function" ? pbomNormalizeWhitespace(el.textContent || "") : (el.textContent || "").trim();
      if (text.length < 30 || text.length > 5000) return;

      const hasProcurementWord =
        typeof PBOM_PROCUREMENT_SIGNAL_RE !== "undefined"
          ? PBOM_PROCUREMENT_SIGNAL_RE.test(text)
          : /\b(bidding|bid|procurement|rfq|itb|rfp|quotation|canvass)\b/i.test(text);

      if (!hasProcurementWord) return;

      const heading = el.querySelector("h1, h2, h3, h4, h5, h6, [class*=\x27title\x27 i]");
      const title = heading ? (typeof pbomNormalizeWhitespace === "function" ? pbomNormalizeWhitespace(heading.textContent) : heading.textContent.trim()) : text.slice(0, 100);
      if (title.length < 8) return;

      const fields = typeof pbomParseLabeledFields === "function" ? pbomParseLabeledFields(el) : {};
      const status = typeof pbomClassifyProcurementStatus === "function" ? pbomClassifyProcurementStatus(text, title, window.location.href) : "ACTIVE";

      let detailUrl = null;
      if (typeof pbomPickDetailLink === "function") {
        detailUrl = pbomPickDetailLink(el, heading, title);
      } else {
        const a = el.querySelector("a[href]");
        detailUrl = a && typeof pbomResolveAnchor === "function" ? pbomResolveAnchor(a) : null;
      }

      if (typeof pbomBuildOpportunityRecord === "function") {
        const record = pbomBuildOpportunityRecord(
          {
            title,
            publish: fields.publish || "",
            closing: fields.closing || "",
            category: fields.category || "Procurement Notice",
            entity: fields.entity || "",
            location: fields.location || "",
            reference: fields.reference || (typeof pbomExtractReferenceNumber === "function" ? pbomExtractReferenceNumber(text) : ""),
            url: detailUrl,
            procurementStatus: status,
          },
          el,
          heading || el,
          index++,
          "article"
        );
        out.push(record);
      }
    });

    return out;
  },
};

if (typeof pbomRegisterAdapter === "function") {
  pbomRegisterAdapter(pbomDocumentListAdapter);
  pbomRegisterAdapter(pbomArticleAnnouncementAdapter);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    pbomDocumentListAdapter,
    pbomArticleAnnouncementAdapter,
  };
}
