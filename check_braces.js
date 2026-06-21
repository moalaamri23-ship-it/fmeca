const fs = require('fs');
const code = fs.readFileSync('App.tsx', 'utf8');
let depth = 0;
for (let i = 0; i < code.length; i++) {
  if (code[i] === '{') depth++;
  if (code[i] === '}') depth--;
}
console.log('Depth at end:', depth);
