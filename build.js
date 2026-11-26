// Builds index.html: src/page.html with src/solver.js inlined (one self-contained file).
const fs = require('fs');
const page = fs.readFileSync(__dirname + '/src/page.html', 'utf8');
const solver = fs.readFileSync(__dirname + '/src/solver.js', 'utf8');
if (/<\/script/i.test(solver)) throw new Error('solver.js must not contain a closing script tag');
if (!page.includes('/*@@SOLVER@@*/')) throw new Error('placeholder missing in page.html');
fs.writeFileSync(__dirname + '/index.html', page.replace('/*@@SOLVER@@*/', () => solver));
console.log('index.html written,', fs.statSync(__dirname + '/index.html').size, 'bytes');
