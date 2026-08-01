'use strict';

const { manifestAsCsv, manifestAsJson } = require('./src/simulator/imei.js');

console.log('CSV Export (5 devices):');
console.log('='.repeat(80));
console.log(manifestAsCsv(5, 25));

console.log('\nJSON Export (3 devices):');
console.log('='.repeat(80));
console.log(manifestAsJson(3, 25));
