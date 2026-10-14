const fs = require('fs');
const vm = require('vm');

const code = fs.readFileSync(require('path').join(__dirname, 'matcher.js'), 'utf8');
const context = { console };
vm.createContext(context);
vm.runInContext(code, context);

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
}

function assert(condition, label) {
  if (!condition) {
    throw new Error(label);
  }
}

// Exact keyword match.
let result = context.pbomMatchKeywords(
  { title: 'AI Software for analytics', category: 'IT', rowText: 'AI Software' },
  ['AI Software'],
  { caseSensitive: false, wholeWord: false, minMatches: 1 }
);
assertEqual(result.matchedCount, 1, 'Exact keyword match should count as one distinct match');
assertEqual(result.matched[0].source, 'Opportunity Title', 'The strongest field should remain the canonical source');
assertEqual(result.matched[0].fields.includes('title'), true, 'The title field should be recorded as a matching field');

// Case-insensitive match.
result = context.pbomMatchKeywords(
  { title: 'POWER BI Dashboard', category: 'Analytics', rowText: 'power bi' },
  ['Power BI'],
  { caseSensitive: false, wholeWord: false, minMatches: 1 }
);
assertEqual(result.matchedCount, 1, 'Upper/lowercase variants should match');

// Whole-word enforcement.
result = context.pbomMatchKeywords(
  { title: 'Software licensing', category: 'Solutions', rowText: 'license renewal and software' },
  ['License'],
  { caseSensitive: false, wholeWord: true, minMatches: 1 }
);
assertEqual(result.matchedCount, 1, 'Whole-word mode should match a stand-alone keyword');
result = context.pbomMatchKeywords(
  { title: 'Software licensing', category: 'Solutions', rowText: 'license renewal and software' },
  ['Licen'],
  { caseSensitive: false, wholeWord: true, minMatches: 1 }
);
assertEqual(result.matchedCount, 0, 'Whole-word mode should reject partial matches');

// Multiple distinct keywords.
result = context.pbomMatchKeywords(
  { title: 'Cloud Services and Data Analytics', category: 'IT', rowText: 'Cloud services and business intelligence' },
  ['Cloud Services', 'Data Analytics', 'Zoom'],
  { caseSensitive: false, wholeWord: false, minMatches: 2 }
);
assertEqual(result.matchedCount, 2, 'Distinct keywords should be counted once each');

// Repeated keyword occurrences should not inflate the count.
result = context.pbomMatchKeywords(
  { title: 'Cloud Services', category: 'IT', rowText: 'Cloud Services — Cloud Services — Cloud Services' },
  ['Cloud Services'],
  { caseSensitive: false, wholeWord: false, minMatches: 1 }
);
assertEqual(result.matchedCount, 1, 'Repeated occurrences of the same keyword should still count once');
assertEqual(result.matched[0].count, 1, 'Repeated keyword hits should not inflate the distinct match count');

// Unrelated page content should not trigger a match when the opportunity record itself does not contain the keyword.
result = context.pbomMatchKeywords(
  {
    title: 'Procurement notice',
    category: 'General',
    rowText: 'No procurement terms in this row.',
    pageText: 'The page footer mentions Cloud Services for a different announcement.'
  },
  ['Cloud Services'],
  { caseSensitive: false, wholeWord: true, minMatches: 1 }
);
assertEqual(result.matchedCount, 0, 'Body/footer content should be ignored when it is outside the opportunity record');

// Empty and invalid inputs should be safe.
result = context.pbomMatchKeywords({ title: 'AI', category: 'IT', rowText: 'AI' }, [], { caseSensitive: false, wholeWord: false, minMatches: 1 });
assertEqual(result.matchedCount, 0, 'Empty keyword lists should return zero matches');
result = context.pbomMatchKeywords({ title: 'AI', category: 'IT', rowText: 'AI' }, ['AI'], undefined);
assertEqual(result.matchedCount, 1, 'Missing options should still work with safe defaults');
result = context.pbomMatchKeywords({ title: 'AI', category: 'IT', rowText: 'AI' }, ['AI'], { minMatches: -2, wholeWord: false });
assertEqual(result.minMatchesMet, true, 'Invalid minimum match values should fall back to a safe default');

console.log('matcher tests passed');
