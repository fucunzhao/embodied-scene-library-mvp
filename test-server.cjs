'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const directory=fs.mkdtempSync(path.join(__dirname,'test-data-'));
const port=Number(process.env.TEST_PORT||5487),origin=`http://127.0.0.1:${port}`;
const password='Test-Only-Strong-Password-123';let proc;
function start(){return new Promise((resolve,reject)=>{proc=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:directory,ADMIN_EMAIL:'admin@test.example',ADMIN_PASSWORD:password,NODE_ENV:'test'}});proc.stdout.on('data',d=>{if(d.toString().includes('listening'))resolve();});proc.stderr.on('data',d=>{if(!d.toString().includes('ExperimentalWarning')&&!d.toString().includes('trace-warnings'))process.stderr.write(d);});proc.on('exit',c=>{if(c)reject(new Error('server exit '+c));});proc.on('error',reject);});}
async function stop(){await new Promise(resolve=>{proc.once('exit',resolve);proc.kill();});}
async function request(url,options={}){const r=await fetch(origin+url,{...options,headers:{Origin:origin,...options.headers}});const text=await r.text();let result;try{result=JSON.parse(text);}catch{result=text;}return{status:r.status,body:result,cookie:r.headers.get('set-cookie')?.split(';')[0],headers:r.headers};}
async function login(email){const r=await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200,JSON.stringify(r.body));return r.cookie;}
const post=(cookie,action,data)=>request('/api/action',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({action,data})});
const read=cookie=>request('/api/state',{headers:{Cookie:cookie}});
(async()=>{try{
 await start();assert.equal((await request('/api/health')).status,200);assert.equal((await request('/api/state')).status,401);
 const admin=await login('admin@test.example');assert.ok(admin);assert.equal((await read(admin)).body.me.passwordHash,undefined);
 const s1=(await post(admin,'account',{name:'Supplier One',email:'one@test.example',role:'供应商',org:'One',password})).body;
 const s2=(await post(admin,'account',{name:'Supplier Two',email:'two@test.example',role:'供应商',org:'Two',password})).body;
 const c1=(await post(admin,'account',{name:'Customer',email:'client@test.example',role:'客户',org:'Client',password})).body;
 const supplier=await login(s1.email),other=await login(s2.email),client=await login(c1.email);
 assert.equal((await post(supplier,'account',{role:'平台管理员'})).status,403);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 const up=await request('/api/upload?name=scene.png',{method:'POST',headers:{Cookie:supplier,'Content-Type':'image/png'},body:png});assert.equal(up.status,201);const image=up.body.url;
 assert.equal((await request('/api/upload?name=scene.png',{method:'POST',headers:{Cookie:client,'Content-Type':'image/png'},body:png})).status,403);
 const fake=await request('/api/upload?name=fake.png',{method:'POST',headers:{Cookie:supplier,'Content-Type':'image/png'},body:Buffer.from('invalid-file')});assert.equal(fake.status,415);
 // A minimal ISO-BMFF header exercises storage and byte-range delivery; playback is separately checked in UI.
 const video=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(128)]);
 const vu=await request('/api/upload?name=task.mp4',{method:'POST',headers:{Cookie:supplier,'Content-Type':'video/mp4'},body:video});assert.equal(vu.status,201);
 const appData={name:'真实厨房',industry:'家庭服务',place:'杭州',task:'物品分类',contact:'负责人',photos:[image],videos:[vu.body.url]};
 assert.equal((await post(other,'apply',appData)).status,400);
 const application=(await post(supplier,'apply',appData)).body;assert.ok(application.id);
 assert.equal((await read(other)).body.applications.length,0);assert.equal((await read(client)).body.scenes.length,0);
 assert.equal((await request(image,{headers:{Cookie:client}})).status,403);assert.equal((await request(image,{headers:{Cookie:other}})).status,403);assert.equal((await request(image,{headers:{Cookie:admin}})).status,200);
 assert.equal((await post(supplier,'review',{id:application.id,decision:'approve'})).status,403);
 const rejected=(await post(supplier,'apply',{...appData,name:'需补充场景'})).body;
 assert.equal((await post(admin,'review',{id:rejected.id,decision:'reject',note:'补充任务说明'})).status,200);
 assert.equal((await post(other,'apply',{...appData,id:rejected.id})).status,400);
 assert.equal((await post(supplier,'apply',{...appData,id:rejected.id,task:'补充后的完整任务'})).status,200);
 assert.equal((await read(supplier)).body.applications.find(x=>x.id===rejected.id).status,'待审核');
 assert.equal((await post(supplier,'apply',{...appData,id:rejected.id})).status,409);
 assert.equal((await post(admin,'review',{id:application.id,decision:'approve'})).status,200);assert.equal((await post(admin,'review',{id:application.id,decision:'approve'})).status,409);
 const scene=(await read(client)).body.scenes[0];assert.equal(scene.photos[0],image);assert.equal((await request(image,{headers:{Cookie:client}})).status,200);
 const range=await request(vu.body.url,{headers:{Cookie:client,Range:'bytes=0-11'}});assert.equal(range.status,206);assert.equal(Number(range.headers.get('content-length')),12);
 assert.equal((await request(vu.body.url,{headers:{Cookie:client,Range:'bytes=900-1000'}})).status,416);
 const task=(await post(admin,'task',{sceneId:scene.id,mode:'pool',date:'2026-10-10'})).body;assert.ok(task.id);
 const claims=await Promise.all([post(supplier,'claim',{id:task.id}),post(other,'claim',{id:task.id})]);assert.deepEqual(claims.map(x=>x.status).sort(),[200,409]);
 const winner=claims[0].status===200?supplier:other,loser=winner===supplier?other:supplier;
 assert.equal((await post(loser,'start',{id:task.id})).status,403);assert.equal((await post(winner,'start',{id:task.id})).status,200);
 const assigned=(await post(admin,'task',{sceneId:scene.id,mode:'assigned',supplierId:s2.id,date:'2026-10-11'})).body;assert.equal(assigned.supplierId,s2.id);assert.ok((await read(other)).body.tasks.find(t=>t.id===assigned.id));
 assert.equal((await post(client,'inquiry',{sceneId:scene.id,contact:'采购联系人'})).status,200);assert.equal((await read(supplier)).body.inquiries.length,0);
 assert.equal((await request('/api/action',{method:'POST',headers:{Origin:'https://bad.example',Cookie:admin,'Content-Type':'application/json'},body:'{}'})).status,403);
 await stop();await start();assert.equal((await read(client)).body.scenes.length,1);assert.equal((await request(image,{headers:{Cookie:client}})).status,200);assert.equal((await read(winner)).body.tasks.find(t=>t.id===task.id).stage,'采集中');
 await post(admin,'toggleAccount',{id:s1.id});assert.equal((await read(supplier)).status,401);
 assert.equal((await request('/api/logout',{method:'POST',headers:{Cookie:client,'Content-Type':'application/json'},body:'{}'})).status,200);assert.equal((await read(client)).status,401);
 console.log('PASS: authentication, upload validation, private media, approval publication, rejection/resubmission, range delivery, account isolation, dispatch, concurrent claims, CSRF, restart persistence, disable and logout.');
 }finally{if(proc&&proc.exitCode===null)await stop();console.log('Test data retained at '+directory);}})().catch(e=>{console.error(e);process.exitCode=1;});
