const fs = require('fs');
const vm = require('vm');

const context = { console };
vm.createContext(context);
vm.runInContext(fs.readFileSync('date-validator.js', 'utf8'), context);

function expectStatus(raw, now, expected, label) {
  const result = context.pbomClassifyPublicationEligibility(raw, now);
  if (result.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${result.status}`);
  }
  return result;
}

const october15 = new Date(2026, 9, 15, 23, 59, 59);
expectStatus('October 15, 2026', october15, 'ELIGIBLE', 'today');
expectStatus('July 15, 2026', october15, 'ELIGIBLE', 'exact three-month boundary');
expectStatus('July 14, 2026', october15, 'OUTSIDE_WINDOW', 'day before boundary');
expectStatus('January 15, 2026', october15, 'OUTSIDE_WINDOW', 'same-year date before window');
expectStatus('December 31, 2025', october15, 'OUTSIDE_WINDOW', 'previous year');
expectStatus('October 16, 2026', october15, 'VERIFY', 'future current-year date');
expectStatus('January 1, 2027', october15, 'VERIFY', 'future next-year date');
expectStatus('2026', october15, 'VERIFY', 'missing month and day');
expectStatus('01/02/2026', october15, 'VERIFY', 'ambiguous numeric date');
expectStatus('not a date', october15, 'VERIFY', 'unparseable date');
expectStatus('October 15, 2026', new Date(2026, 9, 15, 0, 0, 1), 'ELIGIBLE', 'timezone/time normalization');

const march31 = new Date(2026, 2, 31);
const monthEnd = expectStatus('December 31, 2025', march31, 'OUTSIDE_WINDOW', 'month-end clamping');
if (monthEnd.start.getFullYear() !== 2025 || monthEnd.start.getMonth() !== 11 || monthEnd.start.getDate() !== 31) {
  throw new Error('month-end boundary did not clamp to the last valid target-month day');
}

const leapDay = expectStatus('November 29, 2023', new Date(2024, 1, 29), 'OUTSIDE_WINDOW', 'leap-year boundary');
if (leapDay.start.getFullYear() !== 2023 || leapDay.start.getMonth() !== 10 || leapDay.start.getDate() !== 29) {
  throw new Error('leap-year three-month boundary was not calculated by calendar month');
}

const leapEligible = expectStatus('November 29, 2024', new Date(2025, 1, 28), 'OUTSIDE_WINDOW', 'previous-year leap date');
if (!leapEligible.date || leapEligible.date.getDate() !== 29) {
  throw new Error('parsed leap-day source date was not preserved');
}

console.log('publication date eligibility tests passed');
