// Local-only provider stand-in. WRITE_DEEPGRAM_URL=http://127.0.0.1:4373/listen
import { createServer } from 'node:http';
let calls = [], status = 200;
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/control') {
    if (req.method === 'POST') { let data = ''; for await (const chunk of req) data += chunk; const value=JSON.parse(data); status=value.status ?? 200; if(value.reset) calls=[]; }
    res.setHeader('content-type','application/json'); res.end(JSON.stringify({calls,status})); return;
  }
  if (url.pathname !== '/listen') { res.writeHead(404).end(); return; }
  let bytes=0; for await (const chunk of req) bytes+=chunk.length;
  calls.push({bytes, query:Object.fromEntries(url.searchParams), contentType:req.headers['content-type'], authenticated:req.headers.authorization==='Token local-test'});
  res.writeHead(status, {'content-type':'application/json'});
  res.end(JSON.stringify(status===200 ? {results:{channels:[{alternatives:[{transcript:'A voice comment about the next paragraph.'}]}]}} : {error:'provider unavailable'}));
}).listen(4373,'127.0.0.1',()=>console.log('Local Deepgram stand-in on 4373'));
