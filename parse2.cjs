const fs = require('fs');
const ts = require('typescript');
const code = fs.readFileSync('App.tsx', 'utf8');

const sf = ts.createSourceFile('App.tsx', code, ts.ScriptTarget.Latest, true);

function visit(node) {
    // If we want to find incomplete blocks, but TS parser is recovery-based...
    return ts.forEachChild(node, visit);
}
// Actually tsc directly reported error TS1005... 
