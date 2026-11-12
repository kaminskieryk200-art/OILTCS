// SPDX-License-Identifier: Apache-2.0
// RESEARCH ONLY: a certificate issuer with injected authenticated directory.
// Not deployed. Authentication must validate the JWT via Supabase Auth;
// listKeys must use that SAME bearer and the staged own/shared RPCs. The staged
// registration service must first verify key possession. The signing private
// key must be held server-side, protected and rotated, never supplied by client.
// Issuing a 24h certificate cannot reflect revocation before expiry. No rate
// limiter, transparency, revocation distribution, native login or audit here.
const U=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const domain=new TextEncoder().encode('RISES-ACCOUNT-KEY-CERT-V1\0');
const unhex=s=>Uint8Array.from(s.match(/../g),x=>parseInt(x,16));
const uuid=s=>unhex(s.replaceAll('-',''));
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
function bytes64(b){let x='';for(const v of b)x+=String.fromCharCode(v);return btoa(x);}
async function body(req){if(!req.body)throw Error('empty');const r=req.body.getReader();let chunks=[],n=0;for(;;){const x=await r.read();if(x.done)break;n+=x.value.length;if(n>2048){await r.cancel();throw Error('large');}chunks.push(x.value);}let b=new Uint8Array(n),p=0;for(const x of chunks){b.set(x,p);p+=x.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}
export function createIssuerLab({authenticate,listKeys,sign,subtle,now=Date.now}){
 if(!authenticate||!listKeys||!sign||!subtle)throw Error('missing dependency');
 const reply=(obj,status)=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 return async request=>{
  if(request.method!=='POST')return reply({error:'method'},405);
  const bearer=request.headers.get('authorization')||'';if(!/^Bearer [^\s]+$/.test(bearer))return reply({error:'unauthorized'},401);
  let caller;try{caller=await authenticate(bearer);}catch{return reply({error:'auth_unavailable'},503);}if(!caller||typeof caller.id!=='string'||!U.test(caller.id))return reply({error:'unauthorized'},401);
  let owner,key;
  try{let j=await body(request);if(!j||Array.isArray(j)||Object.keys(j).sort().join(',')!=='owner,public_key_hex'||!U.test(j.owner||'')||typeof j.public_key_hex!=='string'||!/^(?:[a-f0-9]{2}){70,200}$/.test(j.public_key_hex))throw Error('bad');owner=j.owner;key=unhex(j.public_key_hex);await subtle.importKey('spki',key,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);}
  catch{return reply({error:'invalid_request'},400);}
  let keys;try{keys=await listKeys(bearer,caller.id,owner);}catch{return reply({error:'directory_unavailable'},503);}
  // Empty/missing shares and invalid keys deliberately get the same result.
  if(!Array.isArray(keys)||keys.length>100||!keys.some(x=>x&&x.public_key_hex===hex(key)&&(owner!==caller.id||x.revoked_at===null)))return reply({error:'key_unavailable'},403);
  const t=now();if(!Number.isSafeInteger(t)||t<0||t>Number.MAX_SAFE_INTEGER-86400000)return reply({error:'clock'},503);
  const end=t+86400000,wire=new Uint8Array(domain.length+32+16+2+key.length);let p=0;wire.set(domain,p);p+=domain.length;wire.set(uuid(owner),p);p+=16;wire.set(uuid(caller.id),p);p+=16;let view=new DataView(wire.buffer);view.setBigUint64(p,BigInt(t));p+=8;view.setBigUint64(p,BigInt(end));p+=8;view.setUint16(p,key.length);p+=2;wire.set(key,p);
  try{let sig=new Uint8Array(await sign(wire));if(sig.length!==64)throw Error('bad signer');let result=new Uint8Array(wire.length+64);result.set(wire);result.set(sig,wire.length);return reply({certificate:bytes64(result)},200);}
  catch{return reply({error:'signer_unavailable'},503);}
 };
}
