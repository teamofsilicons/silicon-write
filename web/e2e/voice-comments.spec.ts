import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { accountsSession, runAccounts, sameOrigin, signIn } from './support';
import { docSyncState, openComments } from './doc-support';
function wav(seconds=1,rate=16000) {
 const b=Buffer.alloc(44+seconds*rate*2); b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;
}
async function provider(status=200,reset=false) { return (await fetch('http://127.0.0.1:4373/control',{method:'POST',body:JSON.stringify({status,reset})})).json(); }
async function fakeMic(page:Page) {
 await page.addInitScript(({audio})=>{
  const state={denied:false,stopped:0}; Object.assign(window,{voiceTest:state});
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{if(state.denied)throw new DOMException('Denied','NotAllowedError');return {getTracks:()=>[{stop:()=>state.stopped++}]};}});
  class Recorder { static isTypeSupported(){return true;} state='inactive';mimeType='audio/wav';ondataavailable?:(e:{data:Blob})=>void;onstop?:()=>void;start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob([Uint8Array.from(atob(audio),c=>c.charCodeAt(0))],{type:'audio/wav'})});queueMicrotask(()=>this.onstop?.());}}
  Object.defineProperty(window,'MediaRecorder',{value:Recorder,configurable:true});
 },{audio:wav().toString('base64')});
}
async function newComment(page:Page) {await page.locator('.ProseMirror p').first().click();await page.keyboard.press('ControlOrMeta+Alt+m');await expect(page.getByRole('dialog',{name:'New comment'})).toBeVisible();}
async function doc(page:Page,title:string) {return (await page.request.post('/api/v1/docs',{headers:sameOrigin(),data:{title,markdown:'A voice anchor.\n'}})).json();}

test('voice recording, dismissal draft, edited transcript, persisted playback and reply',async({browser})=>{
 await provider(200,true);const context=await accountsSession(browser,'carbon',{reducedMotion:'reduce'});const page=await context.newPage();await fakeMic(page);page.setDefaultTimeout(15000);
 try {
  await signIn(page,runAccounts().carbon.email,'/library');const d=await doc(page,'Voice comment test');await page.goto(`/d/${d.id}`);await expect(docSyncState(page)).toHaveAccessibleName('Connected and synced');await newComment(page);
  const box=page.getByRole('dialog',{name:'New comment'}), field=box.getByRole('combobox',{name:'Comment',exact:true});
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
  await page.evaluate(()=>{(window as unknown as {voiceTest:{denied:boolean}}).voiceTest.denied=false;});await box.getByRole('button',{name:'Record voice comment'}).click();await box.getByRole('button',{name:'Stop recording'}).click();await expect(box.getByRole('alert')).toContainText('Your recording is saved');await expect(field).toHaveValue('Keep this text.');await expect(box.locator('audio')).toBeVisible();
  await provider();await box.getByRole('button',{name:'Retry transcription'}).click();await expect(field).toHaveValue('Keep this text.\nA voice comment about the next paragraph.');await box.getByRole('button',{name:'Discard'}).click();await newComment(page);await expect(box.locator('audio')).toHaveCount(0);await expect(field).toHaveValue('');
 }finally{await provider();await context.close();}
});

test('recordings enforce permissions, attachment binding, media limits, cached STT and byte ranges',async({browser})=>{
 await provider(200,true);const owner=await accountsSession(browser,'carbon'),friend=await accountsSession(browser,'friend');const page=await owner.newPage(),guest=await friend.newPage();
 try {
  await signIn(page,runAccounts().carbon.email,'/library');await signIn(guest,runAccounts().friend.email,'/library');const d=await doc(page,'Private voice fixture'),other=await doc(page,'Other voice fixture');
  const upload=(p:Page,buffer=wav())=>p.request.post(`/api/v1/docs/${d.id}/recordings`,{headers:sameOrigin(),multipart:{audio:{name:'comment.wav',mimeType:'audio/wav',buffer}}});
  expect((await page.request.post(`/api/v1/docs/${d.id}/sharing`,{headers:sameOrigin(),data:{to:runAccounts().friend.id,role:'viewer'}})).ok()).toBeTruthy();expect((await upload(guest)).status()).toBe(403);expect((await upload(page,Buffer.from('<script>fake audio</script>'))).status()).toBe(422);expect((await upload(page,wav(181,8000))).status()).toBe(422);expect((await upload(page,Buffer.alloc(3*1024*1024+1))).status()).toBe(413);
  // Chrome/Firefox emit Opus WebM; Safari emits AAC MP4. Both must decode to seekable WAV.
  for (const [codec,format,flags] of [['libopus','webm',[]],['aac','mp4',['-movflags','frag_keyframe+empty_moov']]] as const) {
    const encoded=execFileSync(process.env.WRITE_FFMPEG || '/opt/homebrew/bin/ffmpeg',['-v','error','-f','wav','-i','pipe:0','-c:a',codec,...flags,'-f',format,'pipe:1'],{input:wav()});
    const converted=await upload(page,encoded);expect(converted.status()).toBe(201);const result=await converted.json();expect(result.duration_ms).toBeGreaterThanOrEqual(990);expect(result.duration_ms).toBeLessThan(1200);
    expect((await page.request.get(`/api/v1/recordings/${result.id}`,{headers:{Range:'bytes=0-43'}})).headers()['content-type']).toBe('audio/wav');
  }
  const uploaded=await upload(page);expect(uploaded.status()).toBe(201);const r=await uploaded.json();expect((await guest.request.get(`/api/v1/recordings/${r.id}`)).status()).toBe(404);expect((await page.request.post(`/api/v1/recordings/${r.id}/transcribe`,{headers:sameOrigin(),data:{}})).status()).toBe(200);await page.request.post(`/api/v1/recordings/${r.id}/transcribe`,{headers:sameOrigin(),data:{}});expect((await provider()).calls).toHaveLength(1);
  const payload={anchor:{quote:'A voice anchor.'},body:'Reviewed voice',recording_id:r.id};expect((await page.request.post(`/api/v1/docs/${other.id}/threads`,{headers:sameOrigin(),data:payload})).status()).toBe(404);const posted=await page.request.post(`/api/v1/docs/${d.id}/threads`,{headers:sameOrigin(),data:payload});expect(posted.status()).toBe(201);const thread=await posted.json();expect((await page.request.post(`/api/v1/docs/${d.id}/threads`,{headers:sameOrigin(),data:payload})).status()).toBe(409);
  const audio=await guest.request.get(`/api/v1/recordings/${r.id}`,{headers:{Range:'bytes=0-43'}});expect(audio.status()).toBe(206);expect(audio.headers()['content-type']).toBe('audio/wav');expect(audio.headers()['content-range']).toBe('bytes 0-43/32044');expect((await audio.body()).subarray(0,4).toString()).toBe('RIFF');expect((await guest.request.get(`/api/v1/recordings/${r.id}`,{headers:{Range:'bytes=99999-'}})).status()).toBe(416);
  await page.request.delete(`/api/v1/comments/${thread.comments[0].id}`,{headers:sameOrigin()});expect((await guest.request.get(`/api/v1/recordings/${r.id}`)).status()).toBe(404);
  const draft=await(await upload(page)).json();await provider(503);for(let i=0;i<5;i++)expect((await page.request.post(`/api/v1/recordings/${draft.id}/transcribe`,{headers:sameOrigin(),data:{}})).status()).toBe(503);expect((await page.request.post(`/api/v1/recordings/${draft.id}/transcribe`,{headers:sameOrigin(),data:{}})).status()).toBe(429);
  expect((await page.request.post(`/api/v1/docs/${d.id}/threads`,{headers:sameOrigin(),data:{anchor:{quote:'A voice anchor.'},recording_id:draft.id}})).status()).toBe(201);expect((await guest.request.get(`/api/v1/recordings/${draft.id}`)).status()).toBe(200);
  const sharing=await(await page.request.get(`/api/v1/docs/${d.id}/sharing`)).json();const member=sharing.members.find((m:{account:{id:string}})=>m.account.id===runAccounts().friend.id);await page.request.delete(`/api/v1/docs/${d.id}/sharing/${member.id}`,{headers:sameOrigin()});expect([403,404]).toContain((await guest.request.get(`/api/v1/recordings/${draft.id}`)).status());
 }finally{await provider();await owner.close();await friend.close();}
});
