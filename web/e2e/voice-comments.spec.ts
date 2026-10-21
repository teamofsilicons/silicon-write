import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { accountsSession, runAccounts, sameOrigin, signIn } from './support';
import { docSyncState, openComments } from './doc-support';
function wav(seconds=1,rate=16000) {
 const b=Buffer.alloc(44+seconds*rate*2); b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;
}
async function provider(status=200,reset=false) { return (await fetch('http://127.0.0.1:4373/control',{method:'POST',body:JSON.stringify({status,reset})})).json(); }
async function fakeMic(page:Page,seconds=1) {
 await page.addInitScript(({audio})=>{
  const state={denied:false,stopped:0}; Object.assign(window,{voiceTest:state});
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{if(state.denied)throw new DOMException('Denied','NotAllowedError');return {getTracks:()=>[{stop:()=>state.stopped++}]};}});
  class Recorder { static isTypeSupported(){return true;} state='inactive';mimeType='audio/wav';ondataavailable?:(e:{data:Blob})=>void;onstop?:()=>void;start(){this.state='recording';}pause(){this.state='paused';}resume(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob([Uint8Array.from(atob(audio),c=>c.charCodeAt(0))],{type:'audio/wav'})});queueMicrotask(()=>this.onstop?.());}}
  Object.defineProperty(window,'MediaRecorder',{value:Recorder,configurable:true});
 },{audio:wav(seconds).toString('base64')});
}
async function newComment(page:Page) {await page.locator('.ProseMirror p').first().click();await page.keyboard.press('ControlOrMeta+Alt+m');await expect(page.getByRole('dialog',{name:'New comment'})).toBeVisible();}
async function doc(page:Page,title:string) {return (await page.request.post('/api/v1/docs',{headers:sameOrigin(),data:{title,markdown:'A voice anchor.\n'}})).json();}

test('voice recording, dismissal draft, edited transcript, persisted playback and reply',async({browser})=>{
 await provider(200,true);const context=await accountsSession(browser,'carbon',{reducedMotion:'reduce'});const page=await context.newPage();await fakeMic(page);page.setDefaultTimeout(15000);
 try {
  await signIn(page,runAccounts().carbon.email,'/library');const d=await doc(page,'Voice comment test');await page.goto(`/d/${d.id}`);await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');await newComment(page);
  const box=page.getByRole('dialog',{name:'New comment'}), field=box.getByRole('combobox',{name:'Comment',exact:true});
  for (const width of [390,320]) {
    await page.setViewportSize({width,height:844});
    await expect.poll(async()=>{const bounds=await box.boundingBox();return bounds!.x+bounds!.width;}).toBeLessThanOrEqual(width);
    await expect(box.getByRole('button',{name:'Record voice comment'})).toBeVisible();
  }
  await page.setViewportSize({width:1440,height:900});
  await field.fill('My introduction.');await box.getByRole('button',{name:'Record voice comment'}).click();await expect(box.getByRole('button',{name:'Stop recording'})).toBeVisible();
  await page.mouse.click(12,350);await expect(box).not.toBeVisible();await expect.poll(()=>page.evaluate(()=>(window as unknown as {voiceTest:{stopped:number}}).voiceTest.stopped)).toBeGreaterThan(0);
  await newComment(page);await expect(field).toHaveValue('My introduction.\nA voice comment about the next paragraph.');
  await page.reload();await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');await newComment(page);await expect(box.locator('audio')).toHaveAttribute('src',/\/api\/v1\/recordings\/r_/);await expect(field).toHaveValue('My introduction.\nA voice comment about the next paragraph.');
  await field.fill('My reviewed transcript.');await box.getByRole('button',{name:'Comment',exact:true}).click();await expect(box).not.toBeVisible();await openComments(page);
  const panel=page.getByRole('complementary',{name:'All comments',exact:true});await expect(panel).toContainText('My reviewed transcript.');await expect(panel.locator('audio')).toHaveCount(1);await expect.poll(()=>panel.locator('audio').first().evaluate((a:HTMLAudioElement)=>a.duration)).toBe(1);
  await panel.getByRole('button',{name:'Record voice comment'}).click();await panel.getByRole('button',{name:'Stop recording'}).click();await expect(panel.getByRole('combobox',{name:'Reply, or @mention someone'})).toHaveValue('A voice comment about the next paragraph.');await panel.getByRole('button',{name:'Send',exact:true}).click();await expect(panel.locator('audio')).toHaveCount(2);
  await page.reload();await openComments(page);await expect(panel.locator('audio')).toHaveCount(2);await page.screenshot({path:'../.dev/production/voice-comments-local.png',fullPage:true});
  const threads=await(await page.request.get(`/api/v1/docs/${d.id}/threads`)).json();expect(threads.threads[0].comments.map((c:{body:string,voice:{id:string}})=>[c.body,Boolean(c.voice.id)])).toEqual([['My reviewed transcript.',true],['A voice comment about the next paragraph.',true]]);
  const calls=(await provider()).calls;expect(calls).toHaveLength(2);expect(calls[0]).toMatchObject({bytes:32000,authenticated:true,query:{model:'nova-3',language:'multi',mip_opt_out:'true',encoding:'linear16'}});
 }finally{await context.close();}
});

test('microphone refusal and provider failure preserve text and allow retry',async({browser})=>{
 await provider(503,true);const context=await accountsSession(browser,'carbon',{reducedMotion:'reduce'});const page=await context.newPage();await fakeMic(page);page.setDefaultTimeout(15000);
 try {
  await signIn(page,runAccounts().carbon.email,'/library');const d=await doc(page,'Voice recovery');await page.goto(`/d/${d.id}`);await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');await newComment(page);
  const box=page.getByRole('dialog',{name:'New comment'}),field=box.getByRole('combobox',{name:'Comment',exact:true});
  await page.evaluate(()=>{(window as unknown as {voiceTest:{denied:boolean}}).voiceTest.denied=true;});await box.getByRole('button',{name:'Record voice comment'}).click();await expect(box.getByRole('alert')).toContainText('Microphone access was denied');await field.fill('Keep this text.');
  await page.route('**/api/v1/docs/*/recordings',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'unavailable',message:'Upload unavailable. Retry.'}})}),{times:1});
  await page.evaluate(()=>{(window as unknown as {voiceTest:{denied:boolean}}).voiceTest.denied=false;});await box.getByRole('button',{name:'Record voice comment'}).click();await box.getByRole('button',{name:'Stop recording'}).click();await expect(box.getByRole('button',{name:'Retry upload'})).toBeVisible();await expect(box.getByRole('button',{name:'Comment',exact:true})).toBeDisabled();await expect(field).toHaveValue('Keep this text.');await box.getByRole('button',{name:'Retry upload'}).click();await expect(box.getByRole('alert')).toContainText('Your recording is saved');await expect(field).toHaveValue('Keep this text.');await expect(box.locator('audio')).toBeVisible();
  await provider();await box.getByRole('button',{name:'Retry transcription'}).click();await expect(field).toHaveValue('Keep this text.\nA voice comment about the next paragraph.');await box.getByRole('button',{name:'Discard'}).click();await newComment(page);await expect(box.locator('audio')).toHaveCount(0);await expect(field).toHaveValue('');
 }finally{await provider();await context.close();}
});

test('recordings enforce permissions, attachment binding, media limits, cached STT and byte ranges',async({browser})=>{
 await provider(200,true);const owner=await accountsSession(browser,'carbon'),friend=await accountsSession(browser,'friend');const page=await owner.newPage(),guest=await friend.newPage();
 try {
  await signIn(page,runAccounts().carbon.email,'/library');await signIn(guest,runAccounts().friend.email,'/library');const d=await doc(page,'Private voice fixture'),other=await doc(page,'Other voice fixture');
  const upload=(p:Page,buffer=wav())=>p.request.post(`/api/v1/docs/${d.id}/recordings`,{headers:sameOrigin(),multipart:{audio:{name:'comment.wav',mimeType:'audio/wav',buffer}}});
  expect((await page.request.post(`/api/v1/docs/${d.id}/sharing`,{headers:sameOrigin(),data:{to:runAccounts().friend.id,role:'viewer'}})).ok()).toBeTruthy();expect((await upload(guest)).status()).toBe(403);expect((await upload(page,Buffer.from('<script>fake audio</script>'))).status()).toBe(422);expect((await upload(page,execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','1801','-c:a','libopus','-f','webm','pipe:1']))).status()).toBe(422);expect((await upload(page,Buffer.alloc(3*1024*1024+1))).status()).toBe(413);
  // Chrome/Firefox emit Opus WebM; Safari emits AAC MP4. Both must decode to seekable WAV.
  for (const [codec,format,flags] of [['libopus','webm',[]],['aac','mp4',['-movflags','frag_keyframe+empty_moov']]] as const) {
    const encoded=execFileSync(process.env.WRITE_FFMPEG || '/opt/homebrew/bin/ffmpeg',['-v','error','-f','wav','-i','pipe:0','-c:a',codec,...flags,'-f',format,'pipe:1'],{input:wav()});
    const converted=await upload(page,encoded);expect(converted.status()).toBe(201);const result=await converted.json();expect(result.duration_ms).toBeGreaterThanOrEqual(990);expect(result.duration_ms).toBeLessThan(1200);
    expect((await page.request.get(`/api/v1/recordings/${result.id}`,{headers:{Range:'bytes=0-43'}})).headers()['content-type']).toBe('audio/wav');
  }
  const uploaded=await upload(page);expect(uploaded.status()).toBe(201);const r=await uploaded.json();
  expect((await guest.request.get(`/api/v1/recordings/${r.id}`)).status()).toBe(403);
  await page.request.post(`/api/v1/docs/${d.id}/sharing`,{headers:sameOrigin(),data:{to:runAccounts().friend.id,role:'commenter'}});
  expect((await guest.request.get(`/api/v1/recordings/${r.id}`)).status()).toBe(404);
  expect((await guest.request.post(`/api/v1/recordings/${r.id}/transcribe`,{headers:sameOrigin(),data:{}})).status()).toBe(404);
  expect((await guest.request.post(`/api/v1/docs/${d.id}/threads`,{headers:sameOrigin(),data:{anchor:{quote:'A voice anchor.'},recording_id:r.id}})).status()).toBe(404);
  expect((await page.request.post(`/api/v1/recordings/${r.id}/transcribe`,{headers:sameOrigin(),data:{}})).status()).toBe(200);await page.request.post(`/api/v1/recordings/${r.id}/transcribe`,{headers:sameOrigin(),data:{}});expect((await provider()).calls).toHaveLength(1);
  const payload={anchor:{quote:'A voice anchor.'},body:'Reviewed voice',recording_id:r.id};expect((await page.request.post(`/api/v1/docs/${other.id}/threads`,{headers:sameOrigin(),data:payload})).status()).toBe(404);const posted=await page.request.post(`/api/v1/docs/${d.id}/threads`,{headers:sameOrigin(),data:payload});expect(posted.status()).toBe(201);const thread=await posted.json();expect((await page.request.post(`/api/v1/docs/${d.id}/threads`,{headers:sameOrigin(),data:payload})).status()).toBe(409);
  const audio=await guest.request.get(`/api/v1/recordings/${r.id}`,{headers:{Range:'bytes=0-43'}});expect(audio.status()).toBe(206);expect(audio.headers()['content-type']).toBe('audio/wav');expect(audio.headers()['content-range']).toBe('bytes 0-43/32044');expect((await audio.body()).subarray(0,4).toString()).toBe('RIFF');expect((await guest.request.get(`/api/v1/recordings/${r.id}`,{headers:{Range:'bytes=99999-'}})).status()).toBe(416);
  await page.request.delete(`/api/v1/comments/${thread.comments[0].id}`,{headers:sameOrigin()});expect((await guest.request.get(`/api/v1/recordings/${r.id}`)).status()).toBe(404);
  const draft=await(await upload(page)).json();await provider(503);for(let i=0;i<5;i++)expect((await page.request.post(`/api/v1/recordings/${draft.id}/transcribe`,{headers:sameOrigin(),data:{}})).status()).toBe(503);expect((await page.request.post(`/api/v1/recordings/${draft.id}/transcribe`,{headers:sameOrigin(),data:{}})).status()).toBe(429);
  expect((await page.request.post(`/api/v1/docs/${d.id}/threads`,{headers:sameOrigin(),data:{anchor:{quote:'A voice anchor.'},recording_id:draft.id}})).status()).toBe(201);expect((await guest.request.get(`/api/v1/recordings/${draft.id}`)).status()).toBe(200);
  const sharing=await(await page.request.get(`/api/v1/docs/${d.id}/sharing`)).json();const member=sharing.members.find((m:{account:{id:string}})=>m.account.id===runAccounts().friend.id);await page.request.delete(`/api/v1/docs/${d.id}/sharing/${member.id}`,{headers:sameOrigin()});expect([403,404]).toContain((await guest.request.get(`/api/v1/recordings/${draft.id}`)).status());
 }finally{await provider();await owner.close();await friend.close();}
});


test('native browser MediaRecorder encodes audio that the server decodes and transcribes',async({browser})=>{
 await provider(200,true);const context=await accountsSession(browser,'carbon',{reducedMotion:'reduce'});const page=await context.newPage();page.setDefaultTimeout(15000);
 // A generated tone replaces microphone input; the browser's real MediaRecorder remains untouched.
 await page.addInitScript(()=>{Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
   const audio=new AudioContext(),destination=audio.createMediaStreamDestination(),tone=audio.createOscillator();tone.connect(destination);tone.start();await audio.resume();return destination.stream;
 }});});
 try {
  await signIn(page,runAccounts().carbon.email,'/library');const d=await doc(page,'Native recording verification');await page.goto(`/d/${d.id}`);await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');await newComment(page);
  const box=page.getByRole('dialog',{name:'New comment'});await box.getByRole('button',{name:'Record voice comment'}).click();await expect(box.getByRole('timer')).toContainText('0:01');await page.screenshot({path:'../.dev/production/voice-recording-waveform.png',fullPage:true});await box.getByRole('button',{name:'Pause recording'}).click();await expect(box.getByRole('img',{name:'Recording paused'})).toBeVisible();await box.getByRole('button',{name:'Resume recording'}).click();await box.getByRole('button',{name:'Stop recording'}).click();await expect(box.getByRole('combobox',{name:'Comment',exact:true})).toHaveValue('A voice comment about the next paragraph.');
  await expect.poll(()=>box.locator('audio').evaluate((audio:HTMLAudioElement)=>audio.duration)).toBeGreaterThan(0.9);
  await box.getByRole('button',{name:'Discard'}).click();
 }finally{await context.close();}
});


test('recording replaces the field, pauses active time, warns once at 25 minutes and stops at 30', async ({browser}) => {
 await provider(200,true); const context=await accountsSession(browser,'carbon',{reducedMotion:'reduce'}); const page=await context.newPage(); await fakeMic(page);
 try {
  await signIn(page,runAccounts().carbon.email,'/library'); const d=await doc(page,'Long recording controls'); await page.goto(`/d/${d.id}`); await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced'); await newComment(page);
  await page.clock.install();
  // Count audible warning tones without using a microphone or speaker output.
  await page.evaluate(()=>{Object.assign(window,{warningTones:0}); const original=AudioContext.prototype.createOscillator; AudioContext.prototype.createOscillator=function(){Object.assign(window,{warningTones:(window as unknown as {warningTones:number}).warningTones+1});return original.call(this);};});
  const box=page.getByRole('dialog',{name:'New comment'}),field=box.getByRole('combobox',{name:'Comment',exact:true});
  await field.fill('Keep my written draft.'); await box.getByRole('button',{name:'Record voice comment'}).click(); await expect(field).toHaveCount(0);
  await expect(box.getByRole('img',{name:'Live recording waveform'})).toBeVisible(); await page.clock.fastForward(60000);
  await box.getByRole('button',{name:'Pause recording'}).click(); const paused=await box.getByRole('timer').textContent(); await page.clock.fastForward(600000); await expect(box.getByRole('timer')).toHaveText(paused!);
  await box.getByRole('button',{name:'Resume recording'}).click(); await page.clock.fastForward(24*60000);
  await expect(box.getByRole('alert')).toContainText('5 minutes left'); await expect.poll(()=>page.evaluate(()=>(window as unknown as {warningTones:number}).warningTones)).toBe(2);
  await page.screenshot({path:'../.dev/production/voice-recording-warning.png',fullPage:true});
  await page.clock.fastForward(60000); expect(await page.evaluate(()=>(window as unknown as {warningTones:number}).warningTones)).toBe(2);
  await page.clock.fastForward(4*60000); await expect(field).toHaveValue('Keep my written draft.\nA voice comment about the next paragraph.'); expect((await provider()).calls).toHaveLength(1);
  await box.getByRole('button',{name:'Remove recording'}).click(); await box.getByRole('button',{name:'Record voice comment'}).click(); await box.getByRole('button',{name:'Pause recording'}).click(); await box.getByRole('button',{name:'Discard recording'}).click(); await expect(field).toHaveValue('Keep my written draft.\nA voice comment about the next paragraph.'); expect((await provider()).calls).toHaveLength(1);
 } finally { await context.close(); }
});

test('chunked recordings support 30 minutes and enforce author, offsets and duration', async ({browser}) => {
 const context=await accountsSession(browser,'carbon'),other=await accountsSession(browser,'friend'); const page=await context.newPage(),guest=await other.newPage();
 try {
  await signIn(page,runAccounts().carbon.email,'/library'); await signIn(guest,runAccounts().friend.email,'/library'); const d=await doc(page,'Chunked recording test');
  const start=await page.request.post(`/api/v1/docs/${d.id}/recording-uploads`,{headers:sameOrigin(),data:{}}); expect(start.ok()).toBeTruthy(); const {id}=await start.json();
  const put=(p:Page,offset:number,data:Buffer)=>p.request.put(`/api/v1/recording-uploads/${id}?offset=${offset}`,{headers:{...sameOrigin(),'Content-Type':'application/octet-stream'},data});
  expect((await put(guest,0,Buffer.from('x'))).status()).toBe(404); expect((await put(page,1,Buffer.from('x'))).status()).toBe(409);
  // 30 minutes of valid low-rate PCM exceeds the host limit and exercises assembly + real decoding.
  const audio=wav(1800,8000); for(let offset=0;offset<audio.length;offset+=3*1024*1024) expect((await put(page,offset,audio.subarray(offset,offset+3*1024*1024))).status()).toBe(200);
  const done=await page.request.post(`/api/v1/recording-uploads/${id}/finish`,{headers:sameOrigin(),data:{}}); expect(done.status()).toBe(201); const recording=await done.json(); expect(recording.duration_ms).toBe(1800000);
  expect((await put(page,audio.length,Buffer.from('x'))).status()).toBe(404);
  const played=await page.request.get(`/api/v1/recordings/${recording.id}`,{headers:{Range:'bytes=0-43'}}); expect(played.status()).toBe(206); expect(played.headers()['content-range']).toBe('bytes 0-43/57600044');
 } finally { await context.close();await other.close(); }
});

test('Format remembers the choice across documents and reloads', async ({browser}) => {
 const context=await accountsSession(browser,'carbon');const page=await context.newPage();
 try {
  await signIn(page,runAccounts().carbon.email,'/library');const first=await doc(page,'Format preference one'),second=await doc(page,'Format preference two');await page.goto(`/d/${first.id}`);await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');
  const toggle=page.getByRole('button',{name:'Format',exact:true});await expect(page.locator('#doc-formatting')).toBeVisible();await toggle.click();await expect(page.locator('#doc-formatting')).toBeHidden();
  await page.goto(`/d/${second.id}`);await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');await expect(page.locator('#doc-formatting')).toBeHidden();await page.reload();await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');await expect(page.locator('#doc-formatting')).toBeHidden();
  await toggle.click();await page.reload();await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');await expect(page.locator('#doc-formatting')).toBeVisible();
 } finally {await context.close();}
});


test('large browser recording is chunked and transcribed without losing its text draft',async({browser})=>{
 await provider(200,true);const context=await accountsSession(browser,'carbon');const page=await context.newPage();await fakeMic(page,100);
 try {
  await signIn(page,runAccounts().carbon.email,'/library');const d=await doc(page,'Large browser recording');await page.goto(`/d/${d.id}`);await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');await newComment(page);
  const box=page.getByRole('dialog',{name:'New comment'}),field=box.getByRole('combobox',{name:'Comment',exact:true});await field.fill('Written first.');await box.getByRole('button',{name:'Record voice comment'}).click();await box.getByRole('button',{name:'Stop recording'}).click();await expect(field).toHaveValue('Written first.\nA voice comment about the next paragraph.');
  await expect.poll(()=>box.locator('audio').evaluate((audio:HTMLAudioElement)=>audio.duration)).toBe(100);expect((await provider()).calls[0].bytes).toBe(3200000);
 }finally{await context.close();}
});
