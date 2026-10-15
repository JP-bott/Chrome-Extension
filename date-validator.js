/* PhilGeps BidOps Matcher - date-validator.js
 * Parses closing date/time text as it commonly appears on PhilGEPS listing
 * pages and classifies it against the mandatory 4-day window rule.
 * Depends on: constants.js (PBOM_DATE_WINDOW_DAYS, PBOM_DATE_STATUS)
 */

var MONTH_NAMES = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Parses a closing date/time string into a Date object.
 * Handles the formats PhilGEPS listings commonly show:
 *   "September 10, 2026 2:00 PM"
 *   "September 10, 2026 - 02:00 PM"
 *   "Sep 10, 2026 14:00"
 *   "09/10/2026 2:00 PM"
 *   "2026-09-10 14:00"
 *   "September 10, 2026" (date only — treated as end-of-day, flagged approximate)
 * Returns { date: Date|null, approximate: boolean }.
 */
function pbomParseClosingDate(rawText) {
  if (!rawText) return { date: null, approximate: false };
  const text = String(rawText).replace(/\s+/g, " ").trim();
  if (!text) return { date: null, approximate: false };

  const timeRe = /(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?/;

  // "Month D, YYYY[ - ]h:mm AM/PM"
  let m = text.match(
    /([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s*[-–—,]?\s*(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?)?/
  );
  if (m) {
    const monthKey = m[1].toLowerCase();
    if (monthKey in MONTH_NAMES) {
      const month = MONTH_NAMES[monthKey];
      const day = parseInt(m[2], 10);
      const year = parseInt(m[3], 10);
      let hour = m[4] != null ? parseInt(m[4], 10) : 23;
      const minute = m[5] != null ? parseInt(m[5], 10) : 59;
      const ampm = m[6] ? m[6].toLowerCase() : null;
      const hasTime = m[4] != null;
      if (ampm === "pm" && hour < 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
      const date = new Date(year, month, day, hour, minute, hasTime ? 0 : 59);
      if (!isNaN(date.getTime())) {
        return { date, approximate: !hasTime };
      }
    }
  }

  // "D Month YYYY[ h:mm AM/PM]" (day-first, common on other agency websites)
  m = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})(?:\s*[-–—,]?\s*(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?)?/);
  if (m && m[2].toLowerCase() in MONTH_NAMES) {
    const month = MONTH_NAMES[m[2].toLowerCase()];
    const day = parseInt(m[1], 10);
    const year = parseInt(m[3], 10);
    let hour = m[4] != null ? parseInt(m[4], 10) : 23;
    const minute = m[5] != null ? parseInt(m[5], 10) : 59;
    const ampm = m[6] ? m[6].toLowerCase() : null;
    const hasTime = m[4] != null;
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const date = new Date(year, month, day, hour, minute, hasTime ? 0 : 59);
    if (!isNaN(date.getTime())) {
      return { date, approximate: !hasTime };
    }
  }

  // "MM/DD/YYYY[ h:mm AM/PM]"
  m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?)?/);
  if (m) {
    const month = parseInt(m[1], 10) - 1;
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    let hour = m[4] != null ? parseInt(m[4], 10) : 23;
    const minute = m[5] != null ? parseInt(m[5], 10) : 59;
    const ampm = m[6] ? m[6].toLowerCase() : null;
    const hasTime = m[4] != null;
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const date = new Date(year, month, day, hour, minute, hasTime ? 0 : 59);
    if (!isNaN(date.getTime())) {
      return { date, approximate: !hasTime };
    }
  }

  // "YYYY-MM-DD[ h:mm]" (ISO-ish)
  m = text.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) {
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const day = parseInt(m[3], 10);
    const hasTime = m[4] != null;
    const hour = hasTime ? parseInt(m[4], 10) : 23;
    const minute = hasTime ? parseInt(m[5], 10) : 59;
    const date = new Date(year, month, day, hour, minute, hasTime ? 0 : 59);
    if (!isNaN(date.getTime())) {
      return { date, approximate: !hasTime };
    }
  }

  return { date: null, approximate: false };
}

/** Alias for parsing a publication date from a source field. */
function pbomParseGenericDate(rawText) {
  return pbomParsePublicationDate(rawText);
}

function pbomCreateValidatedLocalDate(year, month, day, hour, minute, second) {
  const date = new Date(year, month, day, hour || 0, minute || 0, second || 0, 0);
  if (
    isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * Parses a publication date without guessing ambiguous numeric formats.
 * Named-month and ISO dates are unambiguous; slash-separated numeric dates
 * are rejected unless a source-specific adapter has already normalized them.
 */
function pbomParsePublicationDate(rawText) {
  if (!rawText) return { date: null, approximate: false, verified: false, reason: "missing" };
  const text = String(rawText).replace(/\s+/g, " ").trim();
  if (!text) return { date: null, approximate: false, verified: false, reason: "missing" };

  let m = text.match(
    /([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s*[-–—,]?\s*(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?)?/
  );
  if (m && m[1].toLowerCase() in MONTH_NAMES) {
    const month = MONTH_NAMES[m[1].toLowerCase()];
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    const date = pbomCreateValidatedLocalDate(year, month, day);
    if (!date) return { date: null, approximate: false, verified: false, reason: "invalid" };
    return { date, approximate: true, verified: true, reason: null };
  }

  m = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})/);
  if (m && m[2].toLowerCase() in MONTH_NAMES) {
    const day = parseInt(m[1], 10);
    const month = MONTH_NAMES[m[2].toLowerCase()];
    const year = parseInt(m[3], 10);
    const date = pbomCreateValidatedLocalDate(year, month, day);
    if (!date) return { date: null, approximate: false, verified: false, reason: "invalid" };
    return { date, approximate: true, verified: true, reason: null };
  }

  m = text.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) {
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const day = parseInt(m[3], 10);
    const date = pbomCreateValidatedLocalDate(year, month, day);
    if (!date) return { date: null, approximate: false, verified: false, reason: "invalid" };
    return { date, approximate: m[4] == null, verified: true, reason: null };
  }

  return { date: null, approximate: false, verified: false, reason: /\d{1,2}[/-]\d{1,2}[/-]\d{4}/.test(text) ? "ambiguous" : "unrecognized" };
}

function pbomNormalizeCalendarDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function pbomSubtractCalendarMonths(date, months) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const targetIndex = year * 12 + month - months;
  const targetYear = Math.floor(targetIndex / 12);
  const targetMonth = targetIndex % 12;
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  return new Date(targetYear, targetMonth, Math.min(day, lastDay));
}

/**
 * Checks publication eligibility using the inclusive calendar-date window
 * [today minus three calendar months, today]. Previous calendar years are
 * always ineligible even when they fall inside the calendar-month boundary.
 */
function pbomClassifyPublicationEligibility(rawText, now) {
  const parsed = pbomParsePublicationDate(rawText);
  if (!parsed.date || !parsed.verified) {
    return { status: "VERIFY", date: null, reason: parsed.reason || "unverified" };
  }

  const today = pbomNormalizeCalendarDate(now || new Date());
  const published = pbomNormalizeCalendarDate(parsed.date);
  const start = pbomSubtractCalendarMonths(today, 3);

  if (published > today) {
    return { status: "VERIFY", date: published, start, end: today, reason: "future_publication_date" };
  }
  if (published.getFullYear() !== today.getFullYear()) {
    return { status: "OUTSIDE_WINDOW", date: published, start, end: today, reason: "previous_or_future_year" };
  }
  if (published < start) {
    return { status: "OUTSIDE_WINDOW", date: published, start, end: today, reason: "outside_three_month_window" };
  }

  return { status: "ELIGIBLE", date: published, start, end: today, reason: null };
}

function pbomPad2(n) {
  return String(n).padStart(2, "0");
}

/** Formats a Date as YYYY-MM-DD using local time components. */
function pbomFormatIsoDateOnly(date) {
  return date.getFullYear() + "-" + pbomPad2(date.getMonth() + 1) + "-" + pbomPad2(date.getDate());
}

/** Formats a Date's time-of-day as HH:MM (24h) using local time components. */
function pbomFormatTimeHHMM(date) {
  return pbomPad2(date.getHours()) + ":" + pbomPad2(date.getMinutes());
}

/**
 * Remaining time in milliseconds (closing - now). Negative means expired.
 */
function pbomComputeRemainingMs(closingDate, now) {
  return closingDate.getTime() - (now || new Date()).getTime();
}

/**
 * Formats a remaining-time duration (ms) as "N days M hours" style text.
 * Assumes ms > 0 (caller should check expiry separately).
 */
function pbomFormatRemaining(ms) {
  if (ms <= 0) return "Expired";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];
  if (days > 0) parts.push(days + (days === 1 ? " day" : " days"));
  if (hours > 0) parts.push(hours + (hours === 1 ? " hour" : " hours"));
  if (days === 0 && hours === 0) parts.push(minutes + (minutes === 1 ? " minute" : " minutes"));
  return parts.join(" ") || "Less than a minute";
}

/**
 * Classifies a raw closing-date string against the mandatory 4-day window.
 * Returns:
 *   {
 *     status: PBOM_DATE_STATUS.*,
 *     date: Date|null,
 *     approximate: boolean,     // true if no explicit time was found (end-of-day assumed)
 *     remainingMs: number|null,
 *     remainingText: string|null,
 *   }
 */
function pbomClassifyClosingDate(rawText, now) {
  const nowDate = now || new Date();
  const { date, approximate } = pbomParseClosingDate(rawText);

  if (!date) {
    return { status: PBOM_DATE_STATUS.INVALID, date: null, approximate: false, remainingMs: null, remainingText: null };
  }

  const remainingMs = pbomComputeRemainingMs(date, nowDate);

  if (remainingMs <= 0) {
    return {
      status: PBOM_DATE_STATUS.EXPIRED,
      date,
      approximate,
      remainingMs,
      remainingText: "Expired",
    };
  }

  const windowMs = PBOM_DATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (remainingMs > windowMs) {
    return {
      status: PBOM_DATE_STATUS.BEYOND_WINDOW,
      date,
      approximate,
      remainingMs,
      remainingText: pbomFormatRemaining(remainingMs),
    };
  }

  return {
    status: PBOM_DATE_STATUS.WITHIN_WINDOW,
    date,
    approximate,
    remainingMs,
    remainingText: pbomFormatRemaining(remainingMs),
  };
}
