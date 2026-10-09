// Review notes for the downloadable interactive map.
//
// Opt-in at download time. Every card gets a small note icon in its top-right
// corner; clicking it pops a sticky note out of the card. The icon turns amber
// once the card carries a note.
//
// A downloaded HTML file cannot write to itself, so notes live in two places:
// this browser's localStorage, keyed by the file's export id, so a reload keeps
// them; and the file itself, when the reviewer presses "Save with notes",
// which downloads a copy with the notes embedded so they can be sent back.
//
// Both strings are injected verbatim into the exported page, so they are
// String.raw and must never contain a backtick, a `${`, or a closing script
// tag. The test in services/__tests__ parses the script to keep it honest.

export const REVIEW_NOTES_CSS = String.raw`
.c.rv{padding-right:22px!important}
.nb{position:absolute;top:3px;right:3px;width:18px;height:18px;display:grid;place-items:center;padding:0;border:0;border-radius:4px;background:transparent;color:#94a3b8;cursor:pointer;z-index:2}
.nb:hover{background:rgba(148,163,184,.2);color:#475569}
.c.dark .nb{color:#64748b}
.c.dark .nb:hover{background:rgba(255,255,255,.08);color:#cbd5e1}
.nb svg{display:block;stroke:currentColor;stroke-width:1.4;stroke-linejoin:round;stroke-linecap:round}
.nb .nb-body{fill:none}
.nb.has,.c.dark .nb.has{color:#d97706}
.nb.has .nb-body{fill:#fcd34d}
.note{position:absolute;z-index:300;width:200px;transform-origin:top left;background:#fef9c3;border:1px solid #fde047;border-radius:6px;box-shadow:0 6px 18px rgba(15,23,42,.18);padding:6px 8px 8px;cursor:default;user-select:text;font-family:Inter,system-ui,sans-serif}
.note-h{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.note-t{flex:1;min-width:0;font-size:10px;font-weight:700;color:#854d0e;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.note-x{flex:none;border:0;background:transparent;color:#a16207;font-size:15px;line-height:1;cursor:pointer;padding:0 2px;border-radius:3px}
.note-x:hover{background:rgba(161,98,7,.12)}
.note textarea{display:block;width:100%;height:84px;resize:none;border:0;background:transparent;outline:none;font-size:12px;line-height:1.4;color:#422006;font-family:inherit;padding:0}
.note textarea::placeholder{color:#a16207;opacity:.6}
`;

export const REVIEW_NOTES_JS = String.raw`
// ── Review notes ────────────────────────────────────────────────────────────
const NOTES_TAG=document.getElementById('review-notes');
const EXPORT_ID=NOTES_TAG.getAttribute('data-export-id')||'map';
const NOTES_KEY='fmeca_review_notes_'+EXPORT_ID;
let NOTES=readNotes();
let openNote=null;
function readNotes(){
  let n={};
  try{n=JSON.parse(decodeURIComponent(NOTES_TAG.textContent.trim()||'%7B%7D'))||{};}catch(e){n={};}
  // This browser's copy wins: it started from the embedded set and also
  // remembers notes the reviewer has since cleared.
  try{const s=localStorage.getItem(NOTES_KEY);if(s)n=JSON.parse(s)||n;}catch(e){}
  return n;
}
function persistNotes(){try{localStorage.setItem(NOTES_KEY,JSON.stringify(NOTES));}catch(e){}syncNoteCount();}
function syncNoteCount(){const c=Object.keys(NOTES).length,b=document.getElementById('notes-count');if(b)b.textContent=c?'('+c+')':'';}
const NOTE_LABELS=(function(){
  const l={};l[DATA.id]=DATA.name;
  DATA.subsystems.forEach(function(s){l[s.id]=s.name;s.failures.forEach(function(f){l[f.id]=f.desc;f.modes.forEach(function(m){l[m.id]=m.mode;});});});
  return l;
})();
const NOTE_ICON='<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path class="nb-body" d="M2.5 2.5h11v7l-4 4h-7z"/><path d="M9.5 13.5v-4h4" fill="none"/></svg>';
function noteTitle(id){return NOTES[id]?'Open review note':'Add a review note';}
// Runs at the end of every render, which rebuilds the cards from scratch.
function decorateNotes(mel){
  mel.querySelectorAll('.c[data-node-id]').forEach(function(card){
    const id=card.dataset.nodeId;
    if(card.classList.contains('bg-slate-900'))card.classList.add('dark');else card.classList.add('rv');
    const b=document.createElement('button');
    b.type='button';b.className='nb'+(NOTES[id]?' has':'');
    b.title=noteTitle(id);b.setAttribute('aria-label',b.title);
    b.innerHTML=NOTE_ICON;
    // The card's own click expands it or focuses it; the icon must do neither.
    b.addEventListener('click',function(e){e.stopPropagation();e.preventDefault();toggleNote(id);});
    card.appendChild(b);
  });
  drawNote(false);
}
function toggleNote(id){openNote=openNote===id?null:id;drawNote(true);}
function closeNote(){openNote=null;drawNote(false);}
function noteCard(){return openNote?document.querySelector('.c[data-node-id="'+CSS.escape(openNote)+'"]'):null;}
function drawNote(focus){
  const old=document.getElementById('note');if(old)old.remove();
  if(!openNote)return;
  const card=noteCard();
  // Its card was collapsed away; the note is still saved, just not shown.
  if(!card){openNote=null;return;}
  clearTimeout(hoverTimer);clearTimeout(hideTimer);
  document.getElementById('tip').style.display='none';
  const id=openNote;
  const n=document.createElement('div');n.id='note';n.className='note';
  const h=document.createElement('div');h.className='note-h';
  const t=document.createElement('div');t.className='note-t';t.textContent=NOTE_LABELS[id]||'Review note';t.title=t.textContent;
  const x=document.createElement('button');x.type='button';x.className='note-x';x.title='Close';x.setAttribute('aria-label','Close note');x.textContent='×';
  x.addEventListener('click',function(e){e.stopPropagation();closeNote();});
  h.appendChild(t);h.appendChild(x);
  const ta=document.createElement('textarea');ta.placeholder='Add a review note…';ta.value=NOTES[id]||'';
  ta.addEventListener('input',function(){
    if(ta.value.trim())NOTES[id]=ta.value;else delete NOTES[id];
    persistNotes();
    const b=card.querySelector('.nb');
    if(b){b.classList.toggle('has',!!NOTES[id]);b.title=noteTitle(id);b.setAttribute('aria-label',b.title);}
  });
  n.appendChild(h);n.appendChild(ta);
  document.getElementById('map').appendChild(n);
  placeNote(true);
  if(focus){ta.focus({preventScroll:true});ta.setSelectionRange(ta.value.length,ta.value.length);}
}
// The note lives in the map's own coordinates, so it rides along with its card
// through every pan and zoom, and is counter-scaled so it keeps the same small,
// readable size on screen whatever the zoom.
function placeNote(chooseSide){
  const n=document.getElementById('note'),card=noteCard();
  if(!n||!card)return;
  const inv=1/mapZoom,cornerX=card.offsetLeft+card.offsetWidth-6;
  n.style.transition=eased?'transform .22s ease':'none';
  n.style.transform='scale('+inv+')';
  n.style.top=(card.offsetTop-6)+'px';
  if(chooseSide){
    // Out to the right of the corner, unless that would run off the window.
    const winW=document.getElementById('win').clientWidth;
    n.dataset.side=panX+cornerX*mapZoom+n.offsetWidth>winW-8?'left':'right';
  }
  n.style.left=(n.dataset.side==='left'?cornerX-n.offsetWidth*inv:cornerX)+'px';
}
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&openNote)closeNote();});
// A file cannot rewrite itself, so the reviewer saves a copy with the notes
// inside it — the copy is what gets sent back.
function saveWithNotes(){
  const doc=document.documentElement.cloneNode(true);
  const m=doc.querySelector('#map');if(m){m.innerHTML='';m.removeAttribute('style');}
  const tip=doc.querySelector('#tip');if(tip){tip.innerHTML='';tip.removeAttribute('style');}
  const fs=doc.querySelector('#fs-btn');if(fs)fs.textContent='Full Screen';
  // Tailwind's CDN writes its generated styles into the head at runtime and
  // writes them again on load; keep only the page's own.
  doc.querySelectorAll('style:not([data-own])').forEach(function(s){s.remove();});
  const tag=doc.querySelector('#review-notes');
  tag.textContent=encodeURIComponent(JSON.stringify(NOTES));
  // A fresh id, so the copy opens on the notes inside it rather than on
  // whatever this browser has stored for the original.
  tag.setAttribute('data-export-id',EXPORT_ID.split('~')[0]+'~'+Date.now().toString(36));
  const blob=new Blob(['<!DOCTYPE html>\n'+doc.outerHTML],{type:'text/html'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=FILE_BASE+'_reviewed.html';
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(a.href);},1000);
}
syncNoteCount();
`;
