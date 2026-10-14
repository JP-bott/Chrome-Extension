/* PhilGeps BidOps Matcher - keyword-highlighter.js
 * Safe, reversible DOM highlighting engine & Ctrl+F navigation controller.
 * Operates purely on text nodes without destroying framework event listeners
 * or overwriting innerHTML on containers.
 * Depends on: constants.js (PBOM_HIGHLIGHT_TYPES, PBOM_HIGHLIGHT_CLASSES)
 */

(function (global) {
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "INPUT", "TEXTAREA", "SELECT",
    "OPTION", "IFRAME", "OBJECT", "EMBED", "TITLE", "SVG", "CANVAS",
    "CODE", "PRE", "HEAD", "META", "LINK", "BUTTON"
  ]);

  let activeMatches = [];
  let currentMatchIndex = -1;
  let currentFilter = "all";
  let lastHighlightedKeywords = [];
  let isNavigating = false;

  function getHighlightClasses() {
    return typeof PBOM_HIGHLIGHT_CLASSES !== "undefined"
      ? PBOM_HIGHLIGHT_CLASSES
      : {
          BASE: "pbom-highlight",
          DIRECT: "pbom-hl-direct",
          POTENTIAL: "pbom-hl-potential",
          PRIORITY: "pbom-hl-priority",
          OPTIONAL: "pbom-hl-optional",
          ACTIVE: "pbom-hl-active",
        };
  }

  function getHighlightTypes() {
    return typeof PBOM_HIGHLIGHT_TYPES !== "undefined"
      ? PBOM_HIGHLIGHT_TYPES
      : {
          DIRECT: "direct",
          POTENTIAL: "potential",
          PRIORITY: "priority",
          OPTIONAL: "optional",
        };
  }

  function shouldSkipNode(node) {
    const classes = getHighlightClasses();
    let el = node.parentElement;
    while (el) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.isContentEditable) return true;
      if (el.classList && el.classList.contains(classes.BASE)) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function collectTextNodes(root) {
    if (!root) root = document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let current;
    while ((current = walker.nextNode())) nodes.push(current);
    return nodes;
  }

  function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildKeywordRegex(keywords, options) {
    if (!keywords || keywords.length === 0) return null;
    const sorted = [...keywords]
      .map((k) => String(k || "").trim())
      .filter((k) => k.length >= 2)
      .sort((a, b) => b.length - a.length);

    if (sorted.length === 0) return null;

    const alternatives = sorted.map((k) => {
      const escaped = escapeRegex(k).replace(/\\\s+/g, "\\s+");
      return options && options.wholeWord ? `\\b${escaped}\\b` : escaped;
    });

    const flags = options && options.caseSensitive ? "g" : "gi";
    try {
      return new RegExp(alternatives.join("|"), flags);
    } catch (e) {
      return null;
    }
  }

  function highlightTextNode(node, regex, classifyFn) {
    const classes = getHighlightClasses();
    const value = node.nodeValue;
    regex.lastIndex = 0;
    if (!regex.test(value)) return [];

    regex.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let match;
    const createdMarks = [];

    while ((match = regex.exec(value)) !== null) {
      if (match.index > lastIndex) {
        frag.appendChild(document.createTextNode(value.slice(lastIndex, match.index)));
      }

      const matchText = match[0];
      const mark = document.createElement("mark");
      mark.className = classes.BASE;
      mark.textContent = matchText;

      const classification = classifyFn(matchText, node.parentElement);
      mark.classList.add(classification.className);
      mark.dataset.pbomType = classification.type;
      mark.dataset.pbomKeyword = matchText.toLowerCase();

      frag.appendChild(mark);
      createdMarks.push(mark);

      lastIndex = match.index + matchText.length;
      if (matchText.length === 0) regex.lastIndex++;
    }

    if (lastIndex < value.length) {
      frag.appendChild(document.createTextNode(value.slice(lastIndex)));
    }

    if (node.parentNode) {
      node.parentNode.replaceChild(frag, node);
    }
    return createdMarks;
  }

  function clearHighlights() {
    const classes = getHighlightClasses();
    const marks = Array.from(document.querySelectorAll(`mark.${classes.BASE}`));
    const parentsToNormalize = new Set();

    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      const textNode = document.createTextNode(mark.textContent);
      parent.replaceChild(textNode, mark);
      parentsToNormalize.add(parent);
    });

    parentsToNormalize.forEach((p) => {
      try {
        p.normalize();
      } catch (e) {}
    });

    activeMatches = [];
    currentMatchIndex = -1;
    return marks.length;
  }

  function highlightMatches({ keywords, terms, options, candidateElements, filterType }) {
    clearHighlights();
    const classes = getHighlightClasses();
    const types = getHighlightTypes();

    const allKeywords = [];
    if (Array.isArray(keywords)) allKeywords.push(...keywords);
    if (Array.isArray(terms)) allKeywords.push(...terms);

    const regex = buildKeywordRegex(allKeywords, options || {});
    if (!regex) {
      return { totalCount: 0, currentIndex: 0, matches: [] };
    }

    lastHighlightedKeywords = allKeywords;
    currentFilter = filterType || "all";

    const candidateSet = new Set(candidateElements || []);

    const classifyFn = (matchedText, parentEl) => {
      let isCandidate = false;
      let inTitle = false;
      let el = parentEl;

      while (el && el !== document.body) {
        if (candidateSet.has(el)) {
          isCandidate = true;
          break;
        }
        if (/^H[1-6]$/.test(el.tagName) || (el.className && /title|heading/i.test(String(el.className)))) {
          inTitle = true;
        }
        el = el.parentElement;
      }

      if (inTitle || isCandidate) {
        return {
          type: types.PRIORITY,
          className: classes.PRIORITY,
        };
      }

      const hasProcurementParent =
        parentEl &&
        typeof PBOM_PROCUREMENT_SIGNAL_RE !== "undefined" &&
        PBOM_PROCUREMENT_SIGNAL_RE.test(parentEl.textContent || "");

      if (hasProcurementParent) {
        return {
          type: types.POTENTIAL,
          className: classes.POTENTIAL,
        };
      }

      return {
        type: types.DIRECT,
        className: classes.DIRECT,
      };
    };

    const textNodes = collectTextNodes(document.body);
    const marks = [];

    textNodes.forEach((node) => {
      const created = highlightTextNode(node, regex, classifyFn);
      if (created && created.length > 0) {
        marks.push(...created);
      }
    });

    marks.forEach((m, idx) => {
      m.dataset.pbomMatchId = String(idx);
    });

    activeMatches = marks;
    filterMatches(currentFilter);

    if (activeMatches.length > 0) {
      currentMatchIndex = 0;
      applyActiveMatch(0);
    } else {
      currentMatchIndex = -1;
    }

    return getMatchStatus();
  }

  function filterMatches(type) {
    const classes = getHighlightClasses();
    currentFilter = type || "all";
    const allMarks = Array.from(document.querySelectorAll(`mark.${classes.BASE}`));

    if (currentFilter === "all") {
      activeMatches = allMarks;
      allMarks.forEach((m) => (m.style.opacity = "1"));
    } else {
      activeMatches = allMarks.filter((m) => m.dataset.pbomType === currentFilter);
      allMarks.forEach((m) => {
        m.style.opacity = m.dataset.pbomType === currentFilter ? "1" : "0.35";
      });
    }

    if (activeMatches.length > 0) {
      currentMatchIndex = 0;
    } else {
      currentMatchIndex = -1;
    }
  }

  function applyActiveMatch(index) {
    const classes = getHighlightClasses();
    if (activeMatches.length === 0) return null;
    const validIndex = ((index % activeMatches.length) + activeMatches.length) % activeMatches.length;

    document.querySelectorAll(`mark.${classes.ACTIVE}`).forEach((m) => {
      m.classList.remove(classes.ACTIVE);
    });

    const target = activeMatches[validIndex];
    if (target) {
      target.classList.add(classes.ACTIVE);
      currentMatchIndex = validIndex;

      try {
        isNavigating = true;
        target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      } finally {
        setTimeout(() => {
          isNavigating = false;
        }, 300);
      }
      return target;
    }
    return null;
  }

  function navigateMatch(direction) {
    if (activeMatches.length === 0) {
      return { totalCount: 0, currentIndex: 0, activeText: null };
    }

    let nextIndex = currentMatchIndex;
    if (direction === "next") {
      nextIndex = (currentMatchIndex + 1) % activeMatches.length;
    } else if (direction === "prev") {
      nextIndex = (currentMatchIndex - 1 + activeMatches.length) % activeMatches.length;
    } else if (typeof direction === "number") {
      nextIndex = direction;
    }

    const activeEl = applyActiveMatch(nextIndex);
    return {
      totalCount: activeMatches.length,
      currentIndex: currentMatchIndex + 1,
      activeText: activeEl ? activeEl.textContent : null,
      type: activeEl ? activeEl.dataset.pbomType : null,
    };
  }

  function getMatchStatus() {
    return {
      totalCount: activeMatches.length,
      currentIndex: currentMatchIndex >= 0 ? currentMatchIndex + 1 : 0,
      filter: currentFilter,
      hasMatches: activeMatches.length > 0,
    };
  }

  function scrollToOpportunityElement(elementOrSelector) {
    let el = typeof elementOrSelector === "string" ? document.querySelector(elementOrSelector) : elementOrSelector;
    if (!el) return false;

    const originalTransition = el.style.transition;
    const originalOutline = el.style.outline;
    const originalShadow = el.style.boxShadow;

    el.style.transition = "outline 0.3s ease, box-shadow 0.3s ease";
    el.style.outline = "2px solid #38e1ff";
    el.style.boxShadow = "0 0 16px rgba(56, 225, 255, 0.4)";

    el.scrollIntoView({ behavior: "smooth", block: "center" });

    setTimeout(() => {
      el.style.outline = originalOutline;
      el.style.boxShadow = originalShadow;
      el.style.transition = originalTransition;
    }, 2500);

    return true;
  }

  global.pbomHighlighter = {
    highlightMatches,
    clearHighlights,
    navigateMatch,
    getMatchStatus,
    filterMatches,
    scrollToOpportunityElement,
    collectTextNodes,
  };
})(typeof window !== "undefined" ? window : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = globalThis.pbomHighlighter || {};
}
