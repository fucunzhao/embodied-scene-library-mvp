'use strict';
const http=require('node:http'), fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'), {pipeline}=require('node:stream/promises'), {Transform}=require('node:stream');
const root=path.resolve(process.env.DATA_DIR||path.join(__dirname,'data')), mediaDir=path.join(root,'media');
fs.mkdirSync(mediaDir,{recursive:true});
const db=new DatabaseSync(path.join(root,'fieldbook.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS records(kind TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,accountId TEXT,expires INTEGER);
 CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,owner TEXT,mime TEXT,size INTEGER,name TEXT,created INTEGER);`);
const id=()=>crypto.randomUUID(), date=()=>new Date().toISOString().slice(0,10);
const all=k=>db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC').all(k).map(r=>JSON.parse(r.body));
function get(k,i){const r=db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(k,i);return r?JSON.parse(r.body):null;}
function put(k,o){db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(k,o.id,JSON.stringify(o));return o;}
function fail(status,message){throw Object.assign(new Error(message),{status});}
function value(v,label,max=2000){if(typeof v!=='string'||!v.trim()||v.length>max)fail(400,`${label}不能为空且长度不能超过${max}`);return v.trim();}
function hash(p){value(p,'密码',128);if(p.length<12)fail(400,'密码至少12位');const salt=crypto.randomBytes(16).toString('hex');return salt+':'+crypto.scryptSync(p,salt,64).toString('hex');}
function matches(p,h){if(typeof p!=='string'||p.length>128||!h)return false;const [s,v]=h.split(':');return crypto.timingSafeEqual(crypto.scryptSync(p,s,64),Buffer.from(v,'hex'));}
const safe=a=>{const {passwordHash,...o}=a;return o;};
if(!all('accounts').length){if(!process.env.ADMIN_EMAIL||!process.env.ADMIN_PASSWORD)throw new Error('首次启动需设置 ADMIN_EMAIL 和至少12位 ADMIN_PASSWORD');put('accounts',{id:id(),name:'平台管理员',email:process.env.ADMIN_EMAIL.toLowerCase(),role:'平台管理员',org:'Fieldbook',scope:'全部权限',status:'启用',passwordHash:hash(process.env.ADMIN_PASSWORD)});}
function token(req){return(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('fb_session='))?.slice(11);}
const digest=t=>crypto.createHash('sha256').update(t).digest('hex');
function account(req){const t=token(req);if(!t)return null;const s=db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(digest(t),Date.now()),a=s&&get('accounts',s.accountId);return a?.status==='启用'?a:null;}
const internal=a=>['平台管理员','内部运营'].includes(a.role);
function permit(a,roles){if(!roles.includes(a.role))fail(403,'当前账号没有此操作权限');}
// Legacy scenes have no lifecycle fields and remain enabled without a destructive migration.
const scenePublished=s=>!!s&&!s.deletedAt&&s.enabled!==false;
function state(a){
 const sceneList=all('scenes'), visible=sceneList.filter(s=>!s.deletedAt&&(internal(a)||scenePublished(s)));
 const poolVisible=t=>t.stage==='待领取'&&scenePublished(get('scenes',t.sceneId));
 const inquiryList=internal(a)?all('inquiries'):all('inquiries').filter(x=>x.ownerId===a.id);
 return{me:safe(a),scenes:visible,archivedScenes:a.role==='平台管理员'?sceneList.filter(s=>s.deletedAt):[],
  applications:internal(a)?all('applications'):all('applications').filter(x=>x.ownerId===a.id),
  tasks:internal(a)?all('tasks'):a.role==='供应商'?all('tasks').filter(t=>poolVisible(t)||t.supplierId===a.id):[],
  inquiries:inquiryList.map(x=>({...x,sceneName:x.sceneName||get('scenes',x.sceneId)?.name||'已归档场景'})),
  accounts:a.role==='平台管理员'?all('accounts').map(safe):[safe(a)]};
}
function mediaRefs(urls,a,kind){if(!Array.isArray(urls)||urls.length>20)fail(400,'每类素材最多20个');return urls.map(url=>{const key=/^\/media\/([a-f0-9-]{36})$/.exec(url)?.[1],m=key&&db.prepare('SELECT * FROM media WHERE id=?').get(key);if(!m||m.owner!==a.id||!m.mime.startsWith(kind+'/'))fail(400,'素材不存在或不属于当前账号');return url;});}
const scopes={'平台管理员':'全部权限','内部运营':'场景审核、任务管理','供应商':'申报、领取与执行任务','客户':'场景库、询盘'};
function action(a,name,b){
 if(['sceneEdit','sceneToggle','sceneDelete','sceneRestore'].includes(name)){
  permit(a,['平台管理员']);
  const scene=get('scenes',b.id);if(!scene)fail(404,'场景不存在');
  if(!Number.isInteger(b.revision)||b.revision!==(scene.revision||0))fail(409,'场景已被其他操作更新，请刷新后重试');
  if(name==='sceneRestore'?!scene.deletedAt:!!scene.deletedAt)fail(409,name==='sceneRestore'?'该场景未删除':'该场景已删除，请先恢复');
  const before=JSON.parse(JSON.stringify(scene));
  if(name==='sceneEdit'){
   const details=b.details||{};
   if(!['可立即采集','方案评估中'].includes(details.status))fail(400,'采集状态无效');
   const updated={name:value(details.name,'场景名称',200),industry:value(details.industry,'所属行业',100),place:value(details.place,'采集环境',300),task:value(details.task,'核心任务'),data:value(details.data,'数据模态',300),cycle:value(details.cycle,'采集周期',300),scale:value(details.scale,'交付规模',300),desc:value(details.desc,'场景介绍',4000),status:details.status};
   if(!Array.isArray(details.tags)||details.tags.length>20||details.tags.some(t=>typeof t!=='string'||!t.trim()||t.length>60))fail(400,'场景标签最多20个，每个不超过60字');
   updated.tags=[...new Set(details.tags.map(t=>t.trim()))];Object.assign(scene,updated);
  }
  if(name==='sceneToggle'){if(typeof b.enabled!=='boolean')fail(400,'启用状态无效');if((scene.enabled!==false)===b.enabled)fail(409,'场景已经处于该状态');scene.enabled=b.enabled;}
  if(name==='sceneDelete'){scene.deletedAt=new Date().toISOString();scene.deletedBy=a.id;}
  // Restoring an archived scene does not silently republish it to customers.
  if(name==='sceneRestore'){delete scene.deletedAt;delete scene.deletedBy;scene.enabled=false;}
  scene.revision=(scene.revision||0)+1;scene.updatedAt=new Date().toISOString();scene.updatedBy=a.id;
  put('sceneChanges',{id:id(),sceneId:scene.id,action:name,actorId:a.id,at:scene.updatedAt,before,after:JSON.parse(JSON.stringify(scene))});
  return put('scenes',scene);
 }
 if(name==='apply'){
  permit(a,['供应商']);const photos=mediaRefs(b.photos,a,'image'),videos=mediaRefs(b.videos,a,'video');if(!photos.length)fail(400,'至少上传一张现场图片');
  const previous=b.id&&get('applications',b.id);if(b.id&&(!previous||previous.ownerId!==a.id))fail(403,'不能修改其他账号的申报');if(previous&&previous.status!=='已退回')fail(409,'仅退回的申报可以修改重提');
  return put('applications',{id:previous?.id||id(),ownerId:a.id,supplier:a.org,name:value(b.name,'场景名称',200),industry:value(b.industry,'行业',100),place:value(b.place,'地点',300),task:value(b.task,'任务'),contact:value(b.contact,'联系人',300),period:String(b.period||'').slice(0,300),data:String(b.data||'').slice(0,300),note:String(b.note||'').slice(0,4000),photos,videos,status:'待审核',date:date()});
 }
 if(name==='review'){
  permit(a,['平台管理员','内部运营']);const app=get('applications',b.id);if(!app)fail(404,'申报不存在');if(app.status!=='待审核')fail(409,'该申报已处理，请刷新');if(!['approve','reject'].includes(b.decision))fail(400,'审核结论无效');
  app.status=b.decision==='approve'?'已通过':'已退回';app.reviewedBy=a.id;app.reviewedAt=new Date().toISOString();app.reviewNote=String(b.note||'').slice(0,2000);
  if(b.decision==='approve')put('scenes',{id:id(),applicationId:app.id,name:app.name,industry:app.industry,status:'可立即采集',place:app.place,task:app.task,data:app.data,cycle:app.period||'待确认',scale:'待评估',type:'custom-cover',tags:['供应商申报'],desc:app.note||app.task,photos:app.photos,videos:app.videos});return put('applications',app);
 }
 if(name==='inquiry'){permit(a,['客户']);const scene=get('scenes',b.sceneId);if(!scenePublished(scene))fail(404,'场景已停用或删除');return put('inquiries',{id:id(),ownerId:a.id,sceneId:b.sceneId,sceneName:scene.name,contact:value(b.contact,'联系方式',300),date:date()});}
 if(name==='account'){
  permit(a,['平台管理员']);const old=b.id&&get('accounts',b.id);if(b.id&&!old)fail(404,'账号不存在');if(!Object.hasOwn(scopes,b.role))fail(400,'角色无效');const email=value(b.email,'邮箱',200).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'邮箱格式无效');if(all('accounts').some(x=>x.email===email&&x.id!==old?.id))fail(409,'邮箱已被使用');if(old?.id===a.id&&b.role!=='平台管理员')fail(400,'不能降低当前管理员自身权限');
  const passwordHash=b.password?hash(b.password):old?.passwordHash;if(!passwordHash)fail(400,'新账号需要设置至少12位密码');const saved=put('accounts',{id:old?.id||id(),name:value(b.name,'名称',200),email,role:b.role,org:value(b.org,'组织',200),scope:scopes[b.role],status:old?.status||'启用',passwordHash});if(old&&(b.password||old.role!==saved.role))db.prepare('DELETE FROM sessions WHERE accountId=?').run(old.id);return safe(saved);
 }
 if(name==='toggleAccount'){permit(a,['平台管理员']);const target=get('accounts',b.id);if(!target)fail(404,'账号不存在');if(target.id===a.id)fail(400,'不能停用当前管理员');target.status=target.status==='启用'?'停用':'启用';db.prepare('DELETE FROM sessions WHERE accountId=?').run(target.id);return safe(put('accounts',target));}
 if(name==='task'){
  permit(a,['平台管理员','内部运营']);const scene=get('scenes',b.sceneId);if(!scenePublished(scene))fail(400,'请选择已启用的审核场景');if(!['pool','assigned'].includes(b.mode))fail(400,'下发方式无效');const supplier=b.mode==='assigned'&&get('accounts',b.supplierId);if(b.mode==='assigned'&&(!supplier||supplier.role!=='供应商'||supplier.status!=='启用'))fail(400,'请选择启用的供应商');return put('tasks',{id:id(),name:scene.name,sceneId:scene.id,stage:supplier?'已排期':'待领取',supplierId:supplier?.id||'',supplier:supplier?.org||'',owner:String(b.owner||'').slice(0,200),date:value(b.date,'计划周期',200),progress:0});
 }
 if(['claim','start','advance'].includes(name)){
  const t=get('tasks',b.id);if(!t)fail(404,'任务不存在');
  if(name==='claim'){permit(a,['供应商']);if(!scenePublished(get('scenes',t.sceneId)))fail(409,'关联场景已停用或删除，不能领取');if(t.stage!=='待领取'||t.supplierId)fail(409,'该任务已被领取');t.supplierId=a.id;t.supplier=a.org;t.stage='已排期';}
  if(name==='start'){permit(a,['供应商']);if(t.supplierId!==a.id)fail(403,'仅能执行自己的任务');if(t.stage!=='已排期')fail(409,'当前任务不能开始');t.stage='采集中';t.progress=10;}
  if(name==='advance'){permit(a,['平台管理员','内部运营']);if(t.stage==='待领取')fail(400,'请先由供应商领取或指派');const steps=['已排期','采集中','验收交付'];t.stage=steps[Math.min(steps.indexOf(t.stage)+1,2)];t.progress=t.stage==='验收交付'?100:10;}
  return put('tasks',t);
 }fail(404,'操作不存在');
}
async function body(req){let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>128*1024)fail(413,'请求过大');chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{fail(400,'请求格式错误');}}
function json(res,status,o){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(o));}
function originCheck(req){const source=req.headers.origin||req.headers.referer;if(!source)fail(403,'缺少请求来源');let u;try{u=new URL(source);}catch{fail(403,'来源无效');}if(!['http:','https:'].includes(u.protocol))fail(403,'来源无效');if(process.env.APP_ORIGIN?u.origin!==process.env.APP_ORIGIN:u.host!==req.headers.host)fail(403,'请求来源不匹配');}
const types={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov'};
function signature(m,b){if(m==='image/jpeg')return b[0]===255&&b[1]===216&&b[2]===255;if(m==='image/png')return b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));if(m==='image/webp')return b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';if(m==='video/webm')return b.subarray(0,4).equals(Buffer.from([26,69,223,163]));return b.toString('ascii',4,8)==='ftyp';}
let activeUploads=0,reservedBytes=0;
async function upload(req,res,a,url){
 permit(a,['供应商']);const mime=(req.headers['content-type']||'').split(';')[0];if(!types[mime])fail(415,'只支持 JPG、PNG、WebP、MP4、WebM、MOV');const limit=mime.startsWith('image/')?20*1024*1024:Number(process.env.MAX_VIDEO_MB||500)*1024*1024,declared=Number(req.headers['content-length']);if(!declared||declared>limit)fail(413,`文件大小需在1字节至${limit/1024/1024}MB之间`);if(activeUploads>=4)fail(429,'上传繁忙，请稍后重试');const used=db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM media').get().n,quota=Number(process.env.STORAGE_QUOTA_GB||20)*1024**3,disk=fs.statfsSync(root);if(used+reservedBytes+declared>quota||disk.bavail*disk.bsize<reservedBytes+declared+256*1024*1024)fail(507,'存储空间不足，请联系管理员');
 const key=id(),temp=path.join(mediaDir,key+'.part'),target=path.join(mediaDir,key);activeUploads++;reservedBytes+=declared;let size=0,head=Buffer.alloc(0);
 try{const check=new Transform({transform(chunk,enc,cb){size+=chunk.length;if(size>limit)return cb(Object.assign(new Error('文件超过限制'),{status:413}));if(head.length<32)head=Buffer.concat([head,chunk]).subarray(0,32);cb(null,chunk);}});await pipeline(req,check,fs.createWriteStream(temp,{flags:'wx'}));if(size!==declared||!signature(mime,head))fail(415,'文件内容与格式不符或上传不完整');fs.renameSync(temp,target);db.prepare('INSERT INTO media VALUES(?,?,?,?,?,?)').run(key,a.id,mime,size,String(url.searchParams.get('name')||'素材').slice(0,200),Date.now());json(res,201,{url:'/media/'+key,size});}
 catch(e){if(fs.existsSync(temp))fs.unlinkSync(temp);if(fs.existsSync(target)&&!db.prepare('SELECT id FROM media WHERE id=?').get(key))fs.unlinkSync(target);throw e;}
 finally{activeUploads--;reservedBytes-=declared;}
}
function serveMedia(req,res,a,key){
 const m=db.prepare('SELECT * FROM media WHERE id=?').get(key);if(!m)fail(404,'素材不存在');const url='/media/'+key,published=all('scenes').some(x=>scenePublished(x)&&[...(x.photos||[]),...(x.videos||[])].includes(url));if(!internal(a)&&m.owner!==a.id&&!published)fail(403,'素材未公开、场景已下架或不属于当前账号');const file=path.join(mediaDir,key);if(!fs.existsSync(file))fail(404,'素材文件缺失');let start=0,end=m.size-1,status=200;
 if(req.headers.range){const r=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!r||(!r[1]&&!r[2])){res.writeHead(416,{'Content-Range':`bytes */${m.size}`});return res.end();}start=r[1]?Number(r[1]):Math.max(0,m.size-Number(r[2]));if(r[1]&&r[2])end=Math.min(end,Number(r[2]));if(start>end||start>=m.size){res.writeHead(416,{'Content-Range':`bytes */${m.size}`});return res.end();}status=206;}
 const headers={'Content-Type':m.mime,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'private, no-store','Content-Disposition':'inline'};if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${m.size}`;res.writeHead(status,headers);if(req.method==='HEAD')return res.end();fs.createReadStream(file,{start,end}).on('error',()=>res.destroy()).pipe(res);
}
const attempts=new Map();
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
 try{const url=new URL(req.url,'http://localhost');if(url.pathname==='/api/health'&&req.method==='GET')return json(res,200,{ok:true});if(req.method==='POST')originCheck(req);
  if(url.pathname==='/api/login'&&req.method==='POST'){
   const k=req.socket.remoteAddress,last=attempts.get(k);if(last&&last.until>Date.now()&&last.count>=20)fail(429,'尝试次数过多，请15分钟后重试');const b=await body(req),a=all('accounts').find(x=>x.email===String(b.email).trim().toLowerCase());if(!a||a.status!=='启用'||!matches(b.password,a.passwordHash)){attempts.set(k,{count:last?.until>Date.now()?last.count+1:1,until:Date.now()+900000});fail(401,'邮箱、密码错误或账号已停用');}attempts.delete(k);const t=crypto.randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(t),a.id,Date.now()+86400000);res.setHeader('Set-Cookie',`fb_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${process.env.NODE_ENV==='production'?'; Secure':''}`);return json(res,200,{me:safe(a)});
  }
  if(url.pathname==='/api/logout'&&req.method==='POST'){const t=token(req);if(t)db.prepare('DELETE FROM sessions WHERE token=?').run(digest(t));res.setHeader('Set-Cookie','fb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');return json(res,200,{ok:true});}
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/media/')){
   const a=account(req);if(!a)fail(401,'请先登录');if(url.pathname==='/api/state'&&req.method==='GET')return json(res,200,state(a));
   if(url.pathname==='/api/suppliers'&&req.method==='GET'){if(!internal(a))fail(403,'没有权限');return json(res,200,all('accounts').filter(x=>x.role==='供应商'&&x.status==='启用').map(x=>({id:x.id,name:x.name,org:x.org})));}
   if(url.pathname==='/api/upload'&&req.method==='POST')return await upload(req,res,a,url);
   if(url.pathname==='/api/action'&&req.method==='POST'){const b=await body(req);db.exec('BEGIN IMMEDIATE');try{const result=action(a,b.action,b.data||{});db.exec('COMMIT');return json(res,200,result);}catch(e){db.exec('ROLLBACK');throw e;}}
   const m=/^\/media\/([a-f0-9-]{36})$/.exec(url.pathname);if(m&&['GET','HEAD'].includes(req.method))return serveMedia(req,res,a,m[1]);fail(404,'接口不存在');
  }
  const file={'/':'index.html','/index.html':'index.html','/embodied-scene-mvp.html':'index.html','/backend-client.js':'backend-client.js'}[url.pathname];if(!file||!['GET','HEAD'].includes(req.method))fail(404,'页面不存在');res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store'});if(req.method==='HEAD')return res.end();fs.createReadStream(path.join(__dirname,file)).pipe(res);
 }catch(e){if(!res.headersSent&&!res.destroyed)json(res,e.status||500,{error:e.status?e.message:'服务器处理失败，请联系管理员'});else res.destroy();if(!e.status)console.error(e);}
});
server.requestTimeout=30*60*1000;
server.listen(Number(process.env.PORT||8080),process.env.HOST||'0.0.0.0',()=>console.log('Fieldbook listening on port '+(process.env.PORT||8080)));
