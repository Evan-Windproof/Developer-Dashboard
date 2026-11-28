import {test} from 'node:test'
import assert from 'node:assert/strict'
import {handleApi} from '../server/api.ts'
import type {Env} from '../server/core.ts'
const origin='https://dashboard.example'
const env={APP_BASE_URL:origin} as Env
const request=(path:string,method='GET')=>handleApi(new Request(origin+path,{method}),env)
test('public demo exposes only public allowlisted metadata without a session',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json([{id:1,name:'public',full_name:'Evan-Windproof/public',owner:{login:'Evan-Windproof'},html_url:'https://github.com/Evan-Windproof/public',private:false,description:'Public',language:'C',stargazers_count:3,forks_count:1,open_issues_count:0,archived:false,fork:false,permissions:{admin:true}},{id:2,name:'private',full_name:'Evan-Windproof/private',owner:{login:'Evan-Windproof'},private:true}]))
 const r=await request('/api/public/repositories');assert.equal(r.status,200)
 assert.equal(r.headers.get('Cache-Control'),'public, max-age=60, s-maxage=300')
 const p=await r.json() as {data:{total:number;repositories:Record<string,unknown>[]}}
 assert.equal(p.data.total,1);assert.equal(p.data.repositories[0].visibility,'public');assert.equal('permissions' in p.data.repositories[0],false)
})
test('private APIs still require sessions and public endpoint rejects writes',async()=>{
 for(const path of ['/api/me','/api/overview','/api/repositories']) {
  const response = await request(path)
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
 }
 const r=await request('/api/public/repositories','POST');assert.equal(r.status,405);assert.equal(r.headers.get('Allow'),'GET')
})
