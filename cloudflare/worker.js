const cors = {
  // The deployed frontend should be configured explicitly at the edge. The
  // wildcard is intentionally removed from the production Worker contract.
  "access-control-allow-origin": "https://demoo.shihab309kye.workers.dev",
  "access-control-allow-headers": "Content-Type, Authorization",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...cors, ...extra } });

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GlobeBridge Messenger</title><style>
*{box-sizing:border-box}body{margin:0;background:#070b16;color:#eef2ff;font:16px system-ui,sans-serif}main{max-width:860px;margin:0 auto;padding:28px 16px}h1{margin:0 0 8px}p{color:#aab4d0}.card{background:#11182a;border:1px solid #263250;border-radius:16px;padding:16px;margin-top:18px}.row{display:flex;gap:8px}.row>*{flex:1}input,button{border-radius:10px;border:1px solid #344365;padding:11px;background:#0b1120;color:#fff;font:inherit}button{cursor:pointer;background:#5b62f4;border-color:#6970ff}button.secondary{background:#202a45}.messages{min-height:260px;max-height:52vh;overflow:auto;display:flex;flex-direction:column;gap:8px;margin:14px 0}.msg{padding:10px 12px;border-radius:12px;background:#1b2741}.msg.mine{background:#343a9b;align-self:flex-end}.muted{font-size:12px;color:#9da9c7}</style></head><body><main><h1>GlobeBridge Messenger</h1><p>Private, administrator-provisioned messaging. Message bodies remain client-encrypted ciphertext.</p><section class="card" id="auth"><div class="row"><input id="email" placeholder="Email"><input id="password" type="password" placeholder="Password"></div><div class="row" style="margin-top:8px"><button id="login">Sign in</button><button class="secondary" id="signup">Create account</button></div><p id="authStatus"></p></section><section class="card" id="chat" hidden><div class="row"><input id="name" placeholder="Conversation name" value="General"><button class="secondary" id="refresh">Refresh</button><button class="secondary" id="logout">Sign out</button></div><div class="messages" id="messages"></div><div class="row"><input id="message" placeholder="Encrypted ciphertext or message text"><button id="send">Send</button></div><p id="status"></p></section></main><script>
let token=localStorage.getItem('gb_token');let me=null;const $=id=>document.getElementById(id);const call=async(path,opts={})=>{const r=await fetch('/api'+path,{...opts,headers:{'content-type':'application/json',...(opts.headers||{}),...(token?{authorization:'Bearer '+token}:{})}});const j=await r.json();if(!r.ok)throw Error(j.error||'Request failed');return j};
async function load(){if(!token)return;try{me=await call('/me');$('auth').hidden=true;$('chat').hidden=false;await refresh()}catch{token=null;localStorage.removeItem('gb_token')}}
async function refresh(){try{const j=await call('/messages');$('messages').innerHTML=j.messages.map(m=>'<div class="msg '+(m.user_id===me.id?'mine':'')+'"><div>'+escapeHtml(m.ciphertext)+'</div><div class="muted">'+escapeHtml(m.email)+' · '+new Date(m.created_at).toLocaleString()+'</div></div>').join('')||'<p>No messages yet.</p>';$('messages').scrollTop=$('messages').scrollHeight}catch(e){$('status').textContent=e.message}}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
$('login').onclick=async()=>{try{const j=await call('/login',{method:'POST',body:JSON.stringify({email:$('email').value,password:$('password').value})});token=j.token;localStorage.setItem('gb_token',token);$('authStatus').textContent='Signed in';await load()}catch(e){$('authStatus').textContent=e.message}};
$('signup').onclick=async()=>{try{const j=await call('/signup',{method:'POST',body:JSON.stringify({email:$('email').value,password:$('password').value})});token=j.token;localStorage.setItem('gb_token',token);await load()}catch(e){$('authStatus').textContent=e.message}};
$('send').onclick=async()=>{const v=$('message').value.trim();if(!v)return;try{await call('/messages',{method:'POST',body:JSON.stringify({ciphertext:v})});$('message').value='';await refresh()}catch(e){$('status').textContent=e.message}};$('message').onkeydown=e=>{if(e.key==='Enter')$('send').click()};$('refresh').onclick=refresh;$('logout').onclick=()=>{token=null;localStorage.removeItem('gb_token');location.reload()};load();
</script></body></html>`;

const tokenFor = () => crypto.randomUUID() + crypto.randomUUID();
async function userFrom(request, env) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  return env.DB.prepare("select u.* from sessions s join users u on u.id=s.user_id where s.token=? and s.expires_at>datetime('now')").bind(await tokenHash(token)).first();
}
let seedPromise;
const videoRate = new Map();
function allowVideoRate(key, limit, windowMs) { const now=Date.now(), hits=(videoRate.get(key)||[]).filter(t=>now-t<windowMs); if(hits.length>=limit){videoRate.set(key,hits);return false;} hits.push(now); videoRate.set(key,hits); return true; }
async function seedAccounts(env) {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
  const accounts = [
    ["admin@globebridge.edu", "Admin#2026!", "admin"],
    ["marcus.lee@globebridge.edu", "User#2026!", "member"],
    ["alina.rahman@globebridge.edu", "User#2026!", "member"],
  ];
  for (const [email, password, role] of accounts) {
    const hash = await hashPassword(password);
    await env.DB.prepare("insert or ignore into users(id,email,password_hash,role) values(?,?,?,?)").bind(`seed-${role}-${email}`, email, hash, role).run();
  }
  })();
  return seedPromise;
}
async function body(request) { try { return await request.json(); } catch { return {}; } }
const worker = { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  // Demo data is opt-in. A production database must be provisioned by an
  // administrator and must never be silently populated on the first request.
  if (env.SEED_DEMO_DATA === "true") await seedAccounts(env);
  if (url.pathname === "/" && request.method === "GET") return new Response(html, { headers: { "content-type": "text/html;charset=UTF-8" } });
  if (url.pathname === "/health") return json({ ok: true, service: "globebridge-messenger", storage: "cloudflare-d1", messageStorage: "ciphertext-only" });
  if (!url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
  const path = url.pathname.slice(4);
  // Account creation is administrator-only. There is deliberately no public
  // signup endpoint in production.
  if (path === "/signup" || path === "/auth/signup") return json({ error: "Public registration is disabled." }, 404);
  if ((path === "/login" || path === "/auth/login") && request.method === "POST") {
    const b = await body(request), email = String(b.email || "").trim().toLowerCase(), user = await env.DB.prepare("select * from users where email=?").bind(email).first();
    if (!user || !(await verifyPassword(String(b.password || ""), user.password_hash))) return json({ error: "Invalid email or password." }, 401);
    const session = await issue(env, user.id);
    const payload = await session.clone().json();
    return json({ ...payload, mfaRequired: false, next: "/app", user: { id: user.id, email: user.email } }, 200, { "set-cookie": `gb_session=${payload.token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=43200` });
  }
  const user = await userFrom(request, env); if (!user) return json({ error: "Authentication required." }, 401);
  if ((path === "/me" || path === "/users/me") && request.method === "GET") {
    const groups = await env.DB.prepare("select g.id,g.name,gm.member_role as memberRole from group_members gm join groups g on g.id=gm.group_id where gm.user_id=? and gm.removed_at is null and g.status='active' order by g.name").bind(user.id).all().catch(() => ({ results: [] }));
    return json({ id:user.id,email:user.email,firstName:user.email.split("@")[0],lastName:"",preferredName:user.email.split("@")[0],userType:user.role === "admin" ? "admin" : "member",status:"active",permissions:user.role === "admin" ? ["*"] : [],roles:[user.role],groups:groups.results });
  }
  if (path === "/auth/logout" && request.method === "POST") {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (token) await env.DB.prepare("delete from sessions where token=?").bind(await tokenHash(token)).run();
    return json({ ok: true });
  }
  if (path === "/directory" && request.method === "GET") {
    const rows = await env.DB.prepare("select id,email,role from users order by email").all();
    return json({ users: rows.results.map(u => ({ id:u.id, email:u.email, name:u.email.split("@")[0], userType:u.role === "admin" ? "administrator" : "member" })) });
  }
  if (path === "/keys" && request.method === "POST") {
    const b = await body(request), deviceId = String(b.deviceId || `device-${user.id}-${crypto.randomUUID()}`);
    await env.DB.prepare("insert or replace into devices(id,user_id,device_name,public_key) values(?,?,?,?)").bind(deviceId,user.id,String(b.deviceName || "Browser"),String(b.publicIdentityKey || "{}")).run();
    return json({ deviceId }, 201);
  }
  if (path === "/notifications" && request.method === "GET") return json({ notifications: [], unreadCount: 0 });
  if (path === "/notifications" && request.method === "POST") return json({ notifications: [], unreadCount: 0 });
  if (path === "/video-meetings" && request.method === "GET") {
    const groupId = new URL(request.url).searchParams.get("groupId");
    if (!groupId) return json({ error: "groupId is required." }, 422);
    const member = await env.DB.prepare("select 1 from group_members where group_id=? and user_id=? and removed_at is null").bind(groupId,user.id).first();
    if (!member && user.role !== "admin") return json({ error: "You are not a member of this group." }, 403);
    const meeting = await env.DB.prepare("select id,group_id,room_name,meeting_type as type,status,title,created_by,created_at,started_at,ended_at from video_meetings where group_id=? and status='active' limit 1").bind(groupId).first();
    return json({ meeting: meeting || null });
  }
  if (path === "/video-meetings" && request.method === "POST") {
    if (!allowVideoRate(`create:${user.id}`,10,60000)) return json({ error: "Too many conference requests. Please slow down." },429);
    const b = await body(request), groupId = String(b.groupId || ""), type = String(b.type || "");
    if (!groupId || !["video","voice"].includes(type)) return json({ error: "A valid groupId and call type are required." }, 422);
    const group = await env.DB.prepare("select * from groups where id=? and status='active'").bind(groupId).first();
    const member = await env.DB.prepare("select 1 from group_members where group_id=? and user_id=? and removed_at is null").bind(groupId,user.id).first();
    if (!group || (!member && user.role !== "admin")) return json({ error: "You are not authorized to start this conference." }, 403);
    if ((type === "video" && !group.video_calls_enabled) || (type === "voice" && !group.voice_calls_enabled)) return json({ error: "This call type is disabled for the group." }, 403);
    if (group.call_start_permission === "admin_only" && user.role !== "admin") return json({ error: "Only administrators can start conferences for this group." },403);
    if (group.call_start_permission === "staff_and_admin" && user.role !== "admin") return json({ error: "Staff or administrator access is required to start conferences." },403);
    const existing = await env.DB.prepare("select * from video_meetings where group_id=? and status='active' limit 1").bind(groupId).first();
    const meeting = existing || { id: crypto.randomUUID(), group_id: groupId, room_name: `gbp-${crypto.randomUUID()}-${crypto.randomUUID()}`, meeting_type: type, status: "active", title: String(b.title || `${type} call`) };
    if (!existing) await env.DB.prepare("insert into video_meetings(id,group_id,created_by,room_name,meeting_type,status,title) values(?,?,?,?,?,?,?)").bind(meeting.id,groupId,user.id,meeting.room_name,type,"active",meeting.title).run();
    await env.DB.prepare("insert or replace into video_meeting_participants(id,meeting_id,user_id,role,status,joined_at,updated_at) values(?,?,?,?,?,?,CURRENT_TIMESTAMP)").bind(crypto.randomUUID(),meeting.id,user.id,user.role === "admin" ? "host" : "participant","joined",new Date().toISOString()).run();
    const token = await workerJitsiToken(env, meeting.room_name, user);
    return json({ meeting: { id: meeting.id, groupId, roomName: meeting.room_name, type: meeting.meeting_type || type, status: "active", title: meeting.title }, group: { id: groupId, name: group.name }, conference: { domain: String(env.JITSI_BASE_URL || "").replace(/\/$/,""), jwt: token, meetingType: meeting.meeting_type || type, screenSharingEnabled: !!group.screen_sharing_enabled, displayName: user.email.split("@")[0], email: user.email } }, 201);
  }
  const videoMatch = path.match(/^\/video-meetings\/([^/]+)$/);
  if (videoMatch && request.method === "POST") {
    if (!allowVideoRate(`join:${user.id}`,30,60000)) return json({ error: "Too many conference requests. Please slow down." },429);
    const meetingId = videoMatch[1], action = new URL(request.url).searchParams.get("action"), meeting = await env.DB.prepare("select m.*,g.name as group_name,g.screen_sharing_enabled from video_meetings m join groups g on g.id=m.group_id where m.id=?").bind(meetingId).first();
    if (!meeting || meeting.status !== "active") return json({ error: "This conference is no longer available." }, 409);
    const member = await env.DB.prepare("select 1 from group_members where group_id=? and user_id=? and removed_at is null").bind(meeting.group_id,user.id).first();
    if (!member && user.role !== "admin") return json({ error: "You are not authorized to join this conference." }, 403);
    const policy = await env.DB.prepare("select call_join_permission from groups where id=?").bind(meeting.group_id).first();
    if (policy?.call_join_permission === "invited_members" && user.role !== "admin") return json({ error: "You are not invited to this conference." },403);
    if (action === "end") { if (user.id !== meeting.created_by && user.role !== "admin") return json({ error: "Only the host or an administrator can end this conference." },403); await env.DB.prepare("update video_meetings set status='ended',ended_at=CURRENT_TIMESTAMP,ended_reason='explicit' where id=? and status='active'").bind(meetingId).run(); return json({ ok:true }); }
    if (action === "leave") { await env.DB.prepare("update video_meeting_participants set status='left',left_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP where meeting_id=? and user_id=?").bind(meetingId,user.id).run(); return json({ ok:true }); }
    if (action !== "join") return json({ error: "action must be join, leave, or end." },422);
    await env.DB.prepare("insert or replace into video_meeting_participants(id,meeting_id,user_id,role,status,joined_at,updated_at) values(?,?,?,?,?,?,CURRENT_TIMESTAMP)").bind(crypto.randomUUID(),meetingId,user.id,user.id===meeting.created_by?"host":"participant","joined",new Date().toISOString()).run();
    return json({ meeting: { id:meeting.id, groupId:meeting.group_id, roomName:meeting.room_name, type:meeting.meeting_type, status:meeting.status, title:meeting.title }, group:{id:meeting.group_id,name:meeting.group_name}, conference:{domain:String(env.JITSI_BASE_URL||"").replace(/\/$/,""),jwt:await workerJitsiToken(env,meeting.room_name,user),meetingType:meeting.meeting_type,screenSharingEnabled:!!meeting.screen_sharing_enabled,displayName:user.email.split("@")[0],email:user.email} });
  }
  if (path === "/reports" && request.method === "POST") {
    const b = await body(request);
    await env.DB.prepare("insert into audit_logs(id,user_id,event_type,target_id) values(?,?,?,?)").bind(crypto.randomUUID(),user.id,"message.reported",String(b.targetId || "")).run();
    return json({ ok: true, id: crypto.randomUUID() }, 201);
  }
  if (path === "/admin/overview" || path === "/admin/users") {
    if (user.role !== "admin") return json({ error: "Administrator access required." }, 403);
    if (path === "/admin/overview" && request.method === "GET") {
      const users = await env.DB.prepare("select count(*) as count from users").first();
      const messages = await env.DB.prepare("select count(*) as count from messages").first();
      const conversations = await env.DB.prepare("select count(*) as count from conversations").first();
      return json({ overview: { users: Number(users?.count || 0), messages: Number(messages?.count || 0), conversations: Number(conversations?.count || 0), activeUsers: Number(users?.count || 0) } });
    }
    if (path === "/admin/users" && request.method === "GET") {
      const rows = await env.DB.prepare("select id,email,role,created_at from users order by created_at desc").all();
      return json({ users: rows.results.map(u => ({ id:u.id,email:u.email,firstName:u.email.split("@")[0],lastName:"",preferredName:null,userType:u.role === "admin" ? "administrator" : "member",status:"active",roles:[u.role],createdAt:u.created_at })) });
    }
    if (path === "/admin/users" && request.method === "POST") {
      const b = await body(request), email = String(b.email || "").trim().toLowerCase(), password = String(b.password || "");
      if (!email || password.length < 8) return json({ error: "Email and password (8+ characters) are required." }, 422);
      const id = crypto.randomUUID();
      try { await env.DB.prepare("insert into users(id,email,password_hash,role) values(?,?,?,?)").bind(id,email,await hashPassword(password),"member").run(); } catch { return json({ error: "That email already exists." }, 409); }
      return json({ user: { id, email, role: "member" } }, 201);
    }
  }
  if (path === "/conversations" && request.method === "GET") {
    const rows = await env.DB.prepare("select c.id,c.type,c.title,c.created_at from conversations c join conversation_members cm on cm.conversation_id=c.id where cm.user_id=? order by c.created_at desc").bind(user.id).all();
    return json({ conversations: rows.results.map(c => ({ ...c, members: [], unreadCount: 0 })) });
  }
  if (path === "/conversations" && request.method === "POST") {
    const b = await body(request), memberIds = Array.isArray(b.memberIds) ? b.memberIds.map(String) : [];
    const ids = [...new Set([user.id, ...memberIds])];
    if (ids.length < 2) return json({ error: "At least one other member is required." }, 422);
    const id = crypto.randomUUID();
    await env.DB.prepare("insert into conversations(id,type,title,created_by) values(?,?,?,?)").bind(id, String(b.type || "direct"), String(b.title || "Encrypted channel"), user.id).run();
    for (const memberId of ids) await env.DB.prepare("insert into conversation_members(conversation_id,user_id,role) values(?,?,?)").bind(id, memberId, memberId === user.id ? "owner" : "participant").run();
    return json({ conversationId: id, created: true }, 201);
  }
  const conversationMatch = path.match(/^\/conversations\/([^/]+)(?:\/(messages|state|keys))?$/);
  if (conversationMatch) {
    const conversationId = conversationMatch[1], subresource = conversationMatch[2];
    const member = await env.DB.prepare("select 1 from conversation_members where conversation_id=? and user_id=?").bind(conversationId, user.id).first();
    if (!member) return json({ error: "Conversation not found." }, 404);
    if (!subresource && request.method === "GET") {
      const conversation = await env.DB.prepare("select * from conversations where id=?").bind(conversationId).first();
      return json({ conversation: { ...conversation, policy: { announcementOnly: false, fileSharingEnabled: true, retentionPolicyDays: null, visibility: "members" }, status: "active" }, membership: { role: "participant", lastReadAt: null, mutedUntil: null, archived: false }, members: [], typing: [], encryption: { hasKeyForMyDevice: true, myDeviceId: null, pendingKeyDevices: [] } });
    }
    if (subresource === "messages" && request.method === "GET") {
      const rows = await env.DB.prepare("select m.*,u.email from messages m join users u on u.id=m.user_id where m.conversation_id=? order by m.created_at asc limit 500").bind(conversationId).all();
      return json({ messages: rows.results.map(m => ({ id:m.id, conversationId:m.conversation_id, senderId:m.user_id, senderDeviceId:m.sender_device_id || "worker", clientMessageId:m.client_message_id || m.id, contentType:m.content_type || "text", ciphertext:m.ciphertext, ciphertextIv:m.ciphertext_iv || "", status:m.status || "sent", serverTimestamp:m.created_at, deletedAt:null })), typing: [], readCursors: [], serverTime: new Date().toISOString() });
    }
    if (subresource === "messages" && request.method === "POST") {
      const b = await body(request), id = crypto.randomUUID(), ciphertext = String(b.ciphertext || "").trim();
      if (!ciphertext) return json({ error: "Ciphertext is required." }, 422);
      await env.DB.prepare("insert into messages(id,user_id,conversation_id,ciphertext,ciphertext_iv,sender_device_id,client_message_id,content_type,status) values(?,?,?,?,?,?,?,?,?)").bind(id,user.id,conversationId,ciphertext,String(b.ciphertextIv || ""),String(b.senderDeviceId || "worker"),String(b.clientMessageId || id),String(b.contentType || "text"),"sent").run();
      return json({ ok: true, id, messageId: id, serverTimestamp: new Date().toISOString() }, 201);
    }
    if (subresource === "state" && request.method === "POST") return json({ ok: true });
    if (subresource === "keys" && request.method === "GET") {
      const devices = await env.DB.prepare("select d.id as deviceId,d.user_id as userId,d.device_name as deviceName,d.public_key as publicKey,case when k.device_id is null then 0 else 1 end as hasKey from devices d join conversation_members cm on cm.user_id=d.user_id left join conversation_key_wraps k on k.device_id=d.id and k.conversation_id=? where cm.conversation_id=? and d.public_key like '%\"kty\"%' and length(d.public_key)>100").bind(conversationId,conversationId).all();
      return json({ myDeviceId: devices.results[0]?.deviceId || null, myDeviceRegistered: devices.results.length > 0, haveKey: false, myWrap: null, memberDevices: devices.results, pendingDevices: devices.results.filter(d => !d.hasKey).map(d => ({ deviceId:d.deviceId, userId:d.userId, publicKey:d.publicKey })) });
    }
    if (subresource === "keys" && request.method === "POST") {
      const b = await body(request), grants = Array.isArray(b.grants) ? b.grants : [];
      for (const grant of grants) await env.DB.prepare("insert or replace into conversation_key_wraps(conversation_id,device_id,wrapped_key,wrapped_key_iv,sender_device_id) values(?,?,?,?,?)").bind(conversationId,String(grant.deviceId),String(grant.wrappedKey),String(grant.wrappedKeyIv),String(grant.senderDeviceId || "browser")).run();
      return json({ ok: true });
    }
  }
  if (path === "/messages" && request.method === "GET") { const r=await env.DB.prepare("select m.*,u.email from messages m join users u on u.id=m.user_id order by m.created_at asc limit 500").all(); return json({messages:r.results}); }
  if (path === "/messages" && request.method === "POST") { const b=await body(request), ciphertext=String(b.ciphertext||"").trim(); if(!ciphertext||ciphertext.length>1000000)return json({error:"Ciphertext is required."},422); const id=crypto.randomUUID(); await env.DB.prepare("insert into messages(id,user_id,ciphertext) values(?,?,?)").bind(id,user.id,ciphertext).run(); await env.DB.prepare("insert into audit_logs(id,user_id,event_type,target_id) values(?,?,?,?)").bind(crypto.randomUUID(),user.id,"message.created",id).run(); return json({ok:true,id},201); }
  return json({ error: "Not found" }, 404);
} };
export default worker;
async function issue(env,id){const token=tokenFor();await env.DB.prepare("insert into sessions(id,user_id,token,expires_at) values(?,?,?,datetime('now','+12 hours'))").bind(crypto.randomUUID(),id,await tokenHash(token)).run();return json({token});}
async function tokenHash(token){const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");}
async function workerJitsiToken(env, room, user) {
  if (!env.JITSI_BASE_URL || !env.JITSI_APP_ID || !env.JITSI_APP_SECRET) throw new Error("Jitsi is not configured");
  const enc = value => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
  const now = Math.floor(Date.now()/1000), header = enc({alg:"HS256",typ:"JWT"}), payload = enc({aud:env.JITSI_JWT_AUDIENCE||env.JITSI_APP_ID,iss:env.JITSI_JWT_ISSUER||env.JITSI_APP_ID,sub:env.JITSI_JWT_SUBJECT||new URL(env.JITSI_BASE_URL).hostname,room,iat:now,exp:now+600,context:{user:{id:user.id,name:user.email.split("@")[0],email:user.email},features:{recording:false,livestreaming:false}}});
  const key = await crypto.subtle.importKey("raw",new TextEncoder().encode(env.JITSI_APP_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signature = await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}`;
}
async function hashPassword(password){const salt=crypto.randomUUID();const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:100000,hash:'SHA-256'},key,256);return salt+':'+btoa(String.fromCharCode(...new Uint8Array(bits)));}
async function verifyPassword(password,stored){const [salt,want]=stored.split(':');const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:100000,hash:'SHA-256'},key,256);const got=btoa(String.fromCharCode(...new Uint8Array(bits)));return got===want;}
