// Loads the SruthiScribe engine straight out of index.html.
//
// The engine lives in a <script> block in the page and already ends with
// `module.exports = API`, so it is loadable as-is -- we just have to cut it out
// of the HTML first. Doing it this way (rather than copying the code into
// tools/) means the harness always measures the engine that actually ships:
// there is exactly one source of truth and it cannot drift.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const HTML = path.join(ROOT, 'index.html');

// The engine block is the one opened by the banner comment. We take from the
// <script> that precedes that banner through its matching </script>.
const START_MARK = 'SruthiScribe engine';

function extractSource(html) {
  const mark = html.indexOf(START_MARK);
  if (mark < 0) throw new Error('engine banner not found in index.html');
  const open = html.lastIndexOf('<script', mark);
  if (open < 0) throw new Error('no <script> before the engine banner');
  const bodyStart = html.indexOf('>', open) + 1;
  const close = html.indexOf('</script>', bodyStart);
  if (close < 0) throw new Error('engine <script> is never closed');
  return html.slice(bodyStart, close);
}

function load() {
  const src = extractSource(fs.readFileSync(HTML, 'utf8'));
  const sandbox = { module: { exports: {} }, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'index.html#engine' });
  const E = sandbox.module.exports;
  if (!E || !E.yinTrack) throw new Error('engine loaded but looks wrong');
  return E;
}

module.exports = { load, extractSource, HTML };
