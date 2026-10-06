'use strict';
const { SourceGenerator } = require('../src/core/generator');
const site = process.argv[2];
const gen = new SourceGenerator({ log: (m) => console.log('  ' + m) });
gen.generate(site).then((r) => {
  console.log('done score=', r.validation && r.validation.score);
}).catch((e) => {
  console.error('STACK:\n' + e.stack);
  process.exit(1);
});
