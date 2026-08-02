// Runs every suite and exits non-zero if any fails. No test framework by design:
// each suite is a standalone Node script that prints PASS/FAIL lines and sets
// its own exit code, so they can also be run individually while debugging.
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');

const suites = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.js') && f !== 'run-all.js')
  .sort();

let failed = [], totalChecks = 0;
for (const s of suites) {
  let out = '';
  let ok = true;
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, s)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    ok = false;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const checks = (out.match(/^ {2}(PASS|FAIL)/gm) || []).length;
  totalChecks += checks;
  const fails = (out.match(/^ {2}FAIL/gm) || []).length;
  if (!ok || fails) {
    failed.push(s);
    console.log('FAIL  ' + s + '  (' + fails + ' of ' + checks + ' checks failed)');
    out.split('\n').filter(l => /^ {2}FAIL/.test(l)).forEach(l => console.log('      ' + l.trim()));
    if (!checks) console.log(out.split('\n').slice(-12).join('\n'));
  } else {
    console.log('ok    ' + s + '  (' + checks + ' checks)');
  }
}
console.log('\n' + suites.length + ' suites, ' + totalChecks + ' checks');
if (failed.length) {
  console.log(failed.length + ' suite(s) failed: ' + failed.join(', '));
  process.exit(1);
}
console.log('all green');
