// The accuracy figures the page prints must be the ones the harness measured.
//
// The page now states its own accuracy, which is the honest thing to do and
// also the thing that rots quietest: a number typed into HTML has nothing
// holding it to the engine it describes. So every figure in the "How accurate
// is it?" disclosure is checked against tools/data/sanidha.json, the result
// file written by `node tools/eval.js --data ~/datasets/sanidha`. Change the
// engine, re-run the harness, and this suite tells you which claims on the
// page are now false.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const chk = (n, c, x = '') => {
  console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  ' + x));
  c ? pass++ : fail++;
};

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const results = path.join(__dirname, '..', 'tools', 'data', 'sanidha.json');

console.log('--- the page publishes its accuracy at all ---');
const block = /<details id="heroAcc">([\s\S]*?)<\/details>/.exec(html);
chk('an accuracy disclosure exists in the hero', !!block);
const body = block ? block[1] : '';
chk('it is collapsed by default, like the other hero disclosure',
    !/<details id="heroAcc"\s+open/.test(html));
chk('it names the dataset it was measured on', /Sanidha/.test(body));
chk('it says the harness runs the shipping engine', /ships/.test(body));
chk('it states the weak spots, not only the good numbers',
    /silences/.test(body) && /not a substitute for a teacher/.test(body));

console.log('--- every printed figure matches the measured result ---');
if (!fs.existsSync(results)) {
  chk('tools/data/sanidha.json exists (run tools/eval.js to write it)', false, results);
} else {
  const s = JSON.parse(fs.readFileSync(results, 'utf8')).summary;
  // Each claim: the text on the page, and the measured value it stands for.
  // Tolerance is half of the last printed digit -- the page rounds, and a
  // claim is wrong only once rounding can no longer explain the gap.
  const claims = [
    ['91.7%', s.svaraAccuracy * 100, 0.05, 'svara accuracy'],
    ['82.5%', s.rawPitchAccuracy * 100, 0.05, 'raw pitch accuracy'],
    ['2.5%', s.octaveErrorRate * 100, 0.05, 'octave error rate'],
    ['3.2¢', s.tonicResidualCents, 0.05, 'tonic residual'],
    ['32%', s.voicingFalseAlarm * 100, 0.5, 'voicing false alarm'],
    ['15%', s.ragamTop1 * 100, 0.5, 'ragam top-1'],
    ['27%', (1 - s.noteCoverage) * 100, 0.5, 'frames declined'],
  ];
  for (const [printed, measured, tol, what] of claims) {
    chk('the page prints ' + printed + ' for ' + what, body.indexOf(printed) >= 0);
    const num = parseFloat(printed);
    chk(printed + ' is what the harness measured (' + measured.toFixed(2) + ')',
        Math.abs(num - measured) <= tol, 'measured ' + measured);
  }
  chk('the page says 33 records and the harness scored 33',
      /33 studio recordings/.test(body) && s.records === 33, 'records ' + s.records);
  chk('it claims five gamaka classes and no more',
      /<b>5<\/b>/.test(body));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
