export class VaultSync {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  json(value, status=200) { return new Response(JSON.stringify(value), {status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}); }
  async fetch(request) {
    if (!['GET','POST'].includes(request.method)) return this.json({error:'Method not allowed'},405);
    let current = await this.ctx.storage.get('collection');
    if (!current) {
      // Test-only seed. No production KV namespace is accessed.
      const original = {purchased:[{name:'TEST GAME',price:2}],changedAt:100};
      current = await this.ctx.storage.transaction(async tx => {
        let row = await tx.get('collection');
        if (!row) {
          row = {revision:0,data:original,recent:[]};
          await tx.put('legacy-backup',original);
          await tx.put('collection',row);
        }
        return row;
      });
    }
    if (request.method === 'GET') return this.json({...current.data,empty:!current.data,revision:current.revision});
    let body;
    try { const raw=await request.text(); if(new TextEncoder().encode(raw).length>1024*1024) return this.json({error:'Collection too large'},413);body=JSON.parse(raw); }
    catch { return this.json({error:'Invalid JSON'},400); }
    if (!body || !Array.isArray(body.purchased) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision<0 || typeof body.operationId!=='string' || !/^[a-zA-Z0-9-]{10,100}$/.test(body.operationId)) return this.json({error:'Update the app before saving'},400);
    return this.ctx.storage.transaction(async tx => {
      const row=await tx.get('collection');
      const done=row.recent.find(x=>x.id===body.operationId);
      if(done) return this.json({ok:true,revision:done.revision,duplicate:true});
      if(body.expectedRevision!==row.revision) return this.json({error:'Another device changed the collection',revision:row.revision},409);
      const {expectedRevision,operationId,...data}=body;
      delete data.revision; delete data.empty;
      data.savedAt=Date.now();
      const revision=row.revision+1;
      await tx.put('previous-collection',row);
      await tx.put('collection',{revision,data,recent:[...row.recent,{id:operationId,revision}].slice(-32)});
      return this.json({ok:true,revision});
    });
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') return new Response('GET only',{status:405});
    if (!env.VAULT_SYNC) return new Response('Next step: add a Durable Object binding named VAULT_SYNC using class VaultSync.',{status:503});
    // A fixed test object keeps repeated visits from creating extra objects.
    const object=env.VAULT_SYNC.get(env.VAULT_SYNC.idFromName('sync-test-only-v1'));
    const send=async(body)=>object.fetch(new Request('https://test.invalid/sync',{method:'POST',body:JSON.stringify(body)}));
    const before=await (await object.fetch(new Request('https://test.invalid/sync'))).json();
    const rev=before.revision;
    const first={purchased:[{name:'TEST GAME',price:3}],changedAt:101,expectedRevision:rev,operationId:crypto.randomUUID()};
    const second={...first,purchased:[{name:'TEST GAME',price:4}],operationId:crypto.randomUUID()};
    const [one,two]=await Promise.all([send(first),send(second)]);
    const winner=one.status===200?first:second;
    const duplicate=await send(winner);
    const old=await send({...first,operationId:crypto.randomUUID()});
    const after=await (await object.fetch(new Request('https://test.invalid/sync'))).json();
    const passed=[one.status,two.status].sort().join(',')==='200,409' && duplicate.status===200 && old.status===409 && after.revision===rev+1;
    return new Response(JSON.stringify({passed,competingSaveStatuses:[one.status,two.status],retryStatus:duplicate.status,staleSaveStatus:old.status,revisionBefore:rev,revisionAfter:after.revision,productionDataUsed:false},null,2),{status:passed?200:500,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }
};
