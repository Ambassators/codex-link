// Local, disposable interaction surface for comparing native computer tools.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const eventFileIndex = process.argv.indexOf('--event-file');
const eventFile = eventFileIndex >= 0 ? process.argv[eventFileIndex + 1] : null;
function report(message) {
  console.log(message);
  if (eventFile && message.startsWith('{')) fs.appendFileSync(eventFile, message + '\n');
}
let fixture;
app.setName('Input parity fixture');
app.whenReady().then(async () => {
  // The automated parity run isolates event delivery from Electron's separate
  // accessibility startup debounce. mac-accessibility.cjs tests that startup.
  if (process.argv.includes('--accessibility-ready')) app.setAccessibilitySupportEnabled(true);
  fixture = new BrowserWindow({ width: 620, height: 740, show: false, webPreferences: { sandbox: true } });
  fixture.webContents.on('console-message', event => report(event.message));
  await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
    <title>Input parity fixture</title>
    <style>body{font:18px system-ui;padding:24px}canvas{border:2px solid #555;display:block}textarea{display:block;width:480px;height:60px;margin:16px 0;font:inherit}#scroller{height:130px;overflow:auto;border:1px solid #555}p{margin:8px 0}</style>
    <h1>Input parity fixture</h1><p id="status">No pointer events</p>
    <canvas width="480" height="120" aria-label="Pointer test canvas"></canvas>
    <textarea placeholder="Type here" aria-label="Text entry"></textarea>
    <p id="textStatus">Text: empty</p>
    <div id="scroller" tabindex="0" aria-label="Scroll test">${Array.from({length:30},(_,i)=>'<p>Row '+(i+1)+'</p>').join('')}</div>
    <p id="scrollStatus">Scroll: 0</p>
    <script>
    let counts={click:0,double:0,right:0,drag:0},start=null;
    const c=document.querySelector('canvas'),ctx=c.getContext('2d');ctx.font='20px system-ui';ctx.fillText('Click, right-click, double-click or drag',12,65);
    function report(){document.querySelector('#status').textContent=JSON.stringify(counts);console.log(JSON.stringify({event:'pointer',...counts}))}
    c.addEventListener('click',e=>{counts.click++;report();console.log(JSON.stringify({event:'click-details',meta:e.metaKey,ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey}))});c.addEventListener('dblclick',()=>{counts.double++;report()});
    c.addEventListener('contextmenu',e=>{e.preventDefault();counts.right++;report()});
    c.addEventListener('mousedown',e=>{start=[e.offsetX,e.offsetY]});c.addEventListener('mouseup',e=>{if(start&&Math.hypot(e.offsetX-start[0],e.offsetY-start[1])>20){counts.drag++;report()}start=null});
    document.querySelector('textarea').addEventListener('input',e=>{document.querySelector('#textStatus').textContent='Text: '+(e.target.value||'empty');console.log(JSON.stringify({event:'text',value:e.target.value}))});
    document.querySelector('#scroller').addEventListener('scroll',e=>{document.querySelector('#scrollStatus').textContent='Scroll: '+Math.round(e.target.scrollTop)});
    </script>`));
  fixture.showInactive();
  report(JSON.stringify({event:'ready',pid:process.pid,accessibility:app.isAccessibilitySupportEnabled()}));
});
app.on('window-all-closed', () => app.quit());
