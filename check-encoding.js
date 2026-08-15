#!/usr/bin/env node
/* Encoding guard.
   The app once shipped garbled text because UTF-8 bytes were read as Latin-1
   after a Windows editor rewrote a file. The source shipped clean and the
   damage happened on write, which is exactly the kind of fault a person will
   not catch by eye and will not remember to check for.

   Run before committing:   node check-encoding.js
   Or wire it in:           git config core.hooksPath .githooks
                            (with a pre-commit that calls this)

   Exits non-zero on failure so a hook or CI step will block the commit. */

const fs = require('fs');

const ASCII_ONLY = ['app.js', 'sw.js', 'index.html'];
const NO_BOM = [...ASCII_ONLY, 'manifest.json'];

let failed = false;
const fail = m => { console.error('  FAIL  ' + m); failed = true; };
const pass = m => console.log('  ok    ' + m);

for (const file of NO_BOM) {
  if (!fs.existsSync(file)) { console.log('  skip  ' + file + ' (not found)'); continue; }
  const raw = fs.readFileSync(file);

  if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
    fail(`${file} starts with a UTF-8 BOM. Re-save without it.`);
    continue;
  }

  if (!ASCII_ONLY.includes(file)) { pass(file + ' (no BOM)'); continue; }

  const text = raw.toString('utf8');
  const bad = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 126) {
      const line = text.slice(0, i).split('\n').length;
      bad.push(`line ${line}: ${JSON.stringify(text[i])} (U+${code.toString(16).toUpperCase().padStart(4, '0')})`);
      if (bad.length >= 10) break;
    }
  }

  if (bad.length) {
    fail(`${file} contains non-ASCII characters. Replace each with a \\uXXXX escape (JS) or an HTML entity (HTML):`);
    bad.forEach(b => console.error('        ' + b));
  } else {
    pass(file + ' (pure ASCII, no BOM)');
  }
}

if (failed) {
  console.error('\nEncoding check failed. Commit blocked.');
  process.exit(1);
}
console.log('\nEncoding check passed.');
