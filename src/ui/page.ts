export function PAGE_HTML(
  status: { connected: boolean; channelTitle?: string | null },
  vapidPublicKey: string | null,
): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  const conn = status.connected
    ? `<span>YouTube: <b>${esc(status.channelTitle ?? 'connected')}</b></span>
       <button id="disconnect">Disconnect</button>`
    : `<a href="/oauth/start"><button>Connect YouTube</button></a>`
  const vapid = JSON.stringify(vapidPublicKey)
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>mkvid</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;background:#0b0b0f;color:#e7e7ea}
  h1{font-size:1.4rem;margin:0}
  h3{margin:.6rem 0 .3rem}
  input,select,button{font:inherit;padding:.5rem;border-radius:.4rem;border:1px solid #333;background:#16161c;color:inherit}
  input:focus,select:focus,button:focus{outline:2px solid #2b6cff;outline-offset:1px}
  button{cursor:pointer;background:#2b6cff;border:none;color:#fff}
  button:hover{background:#3d7bff}
  #disconnect{background:#3a1f1f;color:#f2b8b8}
  #disconnect:hover{background:#4a2626}
  a{color:#7aa2ff}
  header{display:flex;gap:1rem;align-items:center;justify-content:space-between;margin-bottom:1rem}
  form{background:#111116;border:1px solid #222;border-radius:.6rem;padding:.8rem}
  .row{display:flex;gap:.5rem;margin:.5rem 0;flex-wrap:wrap}
  .bar{height:.5rem;background:#222;border-radius:.4rem;overflow:hidden;margin:.3rem 0}
  .bar>i{display:block;height:100%;background:#2b6cff;width:0;transition:width .2s ease}
  .job{border:1px solid #222;border-radius:.5rem;padding:.5rem;margin:.4rem 0}
  #current:empty{display:none}
  #log{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.8rem;max-height:12rem;overflow:auto;color:#9aa;margin-top:.5rem}
  #notif{margin:.6rem 0}
</style></head><body>
<header>
  <h1>mkvid</h1><div id="conn">${conn}</div>
</header>
<form id="f">
  <input id="url" type="url" placeholder="https://soundcloud.com/..." style="width:100%"/>
  <div class="row" style="align-items:center">
    <span style="color:#9aa">or upload audio:</span>
    <input id="file" type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.m4b,.aac,.ogg,.oga,.opus,.wma,.aiff,.aif,.mka,.webm,.ac3,.amr,.ape,.wv"/>
  </div>
  <div class="row">
    <select id="privacy"><option value="private" selected>Private</option>
      <option value="unlisted">Unlisted</option><option value="public">Public</option></select>
    <select id="style"><option value="static" selected>Static waveform</option>
      <option value="waves">Oscilloscope</option></select>
    <button type="submit">Make video</button>
  </div>
</form>
<div id="notif"></div>
<section id="current"></section>
<h3>Recent</h3><div id="jobs"></div>
<div id="log"></div>
<script>
const VAPID = ${vapid};
const $ = (s) => document.querySelector(s);
// The ?yt=connected / ?yt_error params are one-shot signals from the OAuth
// redirect. The connection status itself is server-rendered from the stored
// token, so consume these into a brief toast and strip them from the URL — the
// address bar must never disagree with the real state.
(function(){
  const p = new URLSearchParams(location.search);
  if (p.has('yt') || p.has('yt_error')) {
    const err = p.get('yt_error');
    const note = document.createElement('div');
    note.textContent = err ? ('YouTube connect failed: ' + err) : 'YouTube connected ✓';
    note.style.cssText = 'margin:.5rem 0;padding:.4rem .6rem;border-radius:.4rem;background:'
      + (err ? '#3a1f1f;color:#f2b8b8' : '#16311f;color:#8fe0a0');
    $('header').after(note);
    setTimeout(() => note.remove(), 4000);
    history.replaceState(null, '', location.pathname);
  }
})();
function bar(p){ return '<div class="bar"><i style="width:'+Math.max(0,p)+'%"></i></div>'; }
function httpsLink(url, text){
  const a=document.createElement('a'); a.textContent=text; a.target='_blank'; a.rel='noopener';
  if(typeof url==='string' && /^https:\\/\\//.test(url)) a.href=url;  // only ever set https hrefs
  return a;
}
async function refreshJobs(){
  const r = await fetch('/api/jobs'); const {jobs} = await r.json();
  const box=$('#jobs'); box.textContent='';
  for(const j of jobs){
    const div=document.createElement('div'); div.className='job';
    const b=document.createElement('b'); b.textContent=j.title||j.url; div.appendChild(b);
    div.appendChild(document.createTextNode(' — '+j.status));
    if(j.videoUrl){ div.appendChild(document.createTextNode(' — ')); div.appendChild(httpsLink(j.videoUrl,'watch')); }
    box.appendChild(div);
  }
}
function subscribe(id){
  const cur = $('#current'); cur.innerHTML = '<h3>Working…</h3><div id="p"></div>';
  const es = new EventSource('/api/jobs/'+id+'/events');
  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type==='progress') $('#p').innerHTML = m.phase+' '+Math.round(m.percent)+'%'+bar(m.percent);
    else if (m.type==='status') $('#p').innerHTML = 'status: '+m.status;
    else if (m.type==='log' && m.line) { const l=$('#log'); l.textContent += m.line+'\\n'; l.scrollTop=l.scrollHeight; }
    else if (m.type==='done'){ cur.textContent=''; const h=document.createElement('h3'); h.textContent='Done ✓'; cur.appendChild(h); cur.appendChild(httpsLink(m.videoUrl, m.videoUrl)); es.close(); refreshJobs(); }
    else if (m.type==='error'){ cur.textContent=''; const h=document.createElement('h3'); h.textContent='Failed ✗'; cur.appendChild(h); const p=document.createElement('p'); p.textContent=m.error; cur.appendChild(p); es.close(); refreshJobs(); }
  };
}
// Cloudflare caps a single request body at ~100MB, so files upload in ordered
// chunks (XHR for per-chunk progress), then a JSON finalize creates the job.
const CHUNK_BYTES = 24*1024*1024;
function putChunk(id, blob, offset, total){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/uploads/'+id+'/chunk');
    xhr.setRequestHeader('x-upload-offset', String(offset));
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (ev) => {
      const pct = (offset+ev.loaded)/total*100;
      $('#p').innerHTML = 'upload '+Math.round(pct)+'%'+bar(pct);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else { let d=''; try{ d = JSON.parse(xhr.responseText).error; }catch(e){} reject(new Error(d || ('HTTP '+xhr.status))); }
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(blob);
  });
}
async function uploadFile(file){
  const initR = await fetch('/api/uploads', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ name:file.name, size:file.size }) });
  if(!initR.ok){ let d=''; try{ d=(await initR.json()).error; }catch(e){} throw new Error(d || ('HTTP '+initR.status)); }
  const {id} = await initR.json();
  const cur = $('#current'); cur.innerHTML = '<h3>Uploading…</h3><div id="p"></div>';
  let sent = 0;
  while (sent < file.size) {
    const chunk = file.slice(sent, sent + CHUNK_BYTES);
    await putChunk(id, chunk, sent, file.size);
    sent += chunk.size;
  }
  const r = await fetch('/api/jobs', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ uploadId:id, privacy:$('#privacy').value, style:$('#style').value }) });
  if(!r.ok){ let d=''; try{ d=(await r.json()).error; }catch(e){} throw new Error(d || ('HTTP '+r.status)); }
  return r.json();
}
$('#f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('#file').files[0];
  const url = $('#url').value.trim();
  if (!file && !url) { alert('Paste a URL or choose an audio file'); return; }
  const btn = $('#f button[type=submit]'); btn.disabled = true;
  try {
    let id;
    if (file) {
      ({id} = await uploadFile(file));
      $('#file').value = '';
    } else {
      const r = await fetch('/api/jobs', { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ url, privacy:$('#privacy').value, style:$('#style').value }) });
      if(!r.ok){ alert('submit failed'); return; }
      ({id} = await r.json());
    }
    subscribe(id); refreshJobs();
  } catch (err) {
    $('#current').textContent = '';
    alert('upload failed: ' + err.message);
  } finally { btn.disabled = false; }
});
// Always render the YouTube connection header from a FRESH status fetch, never
// from the (possibly bfcached/stale) server-rendered HTML shell or URL params.
function renderConn(s){
  const el=$('#conn'); el.textContent='';
  if(s && s.connected){
    const span=document.createElement('span'); span.textContent='YouTube: ';
    const b=document.createElement('b'); b.textContent=s.channelTitle||'connected'; span.appendChild(b);
    el.appendChild(span); el.appendChild(document.createTextNode(' '));
    const btn=document.createElement('button'); btn.id='disconnect'; btn.textContent='Disconnect';
    btn.addEventListener('click', async ()=>{ btn.disabled=true; await fetch('/oauth/disconnect',{method:'POST'}); refreshConn(); });
    el.appendChild(btn);
  } else {
    const a=document.createElement('a'); a.href='/oauth/start';
    const btn=document.createElement('button'); btn.textContent='Connect YouTube';
    a.appendChild(btn); el.appendChild(a);
  }
}
async function refreshConn(){ try{ const r=await fetch('/api/youtube/status',{cache:'no-store'}); if(r.ok) renderConn(await r.json()); }catch(e){} }
refreshConn();
function urlB64ToU8(base64){ const pad='='.repeat((4-base64.length%4)%4);
  const b=(base64+pad).replace(/-/g,'+').replace(/_/g,'/'); const raw=atob(b);
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0))); }
if (VAPID && 'serviceWorker' in navigator && 'PushManager' in window) {
  $('#notif').innerHTML = '<button id="enn">Enable notifications</button>';
  $('#enn').addEventListener('click', async () => {
    const perm = await Notification.requestPermission(); if(perm!=='granted') return;
    const reg = await navigator.serviceWorker.register('/sw.js');
    const s = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: urlB64ToU8(VAPID) });
    await fetch('/api/push/subscribe',{ method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(s) });
    $('#notif').innerHTML = 'Notifications enabled ✓';
  });
}
refreshJobs();
</script></body></html>`
}
