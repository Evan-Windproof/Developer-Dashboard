import { ApiError } from './core.ts'

type Repo = {
  id:number; name:string; full_name:string; owner:{login:string}; html_url:string; private:boolean
  description:string|null; language:string|null; stargazers_count:number; forks_count:number
  open_issues_count:number; default_branch:string|null; created_at:string|null; updated_at:string|null
  pushed_at:string|null; archived:boolean; fork:boolean
}
const url='https://api.github.com/users/Evan-Windproof/repos?type=owner&sort=updated&per_page=100'
let snapshot:{repositories:Record<string,unknown>[];fetchedAt:string}|undefined
let cachedUntil=0
async function logPublicGitHubFailure(response: Response) {
  const body = await response.json<{ message?: unknown }>().catch(() => null)
  const message = typeof body?.message === 'string' ? body.message : ''
  const categories: [RegExp, string][] = [
    [/secondary rate limit|abuse detection/i, 'secondary_rate_limit'],
    [/API rate limit exceeded/i, 'primary_rate_limit'],
    [/^Bad credentials$/i, 'bad_credentials'],
    [/^Not Found$/i, 'not_found'],
    [/^Requires authentication$/i, 'requires_authentication'],
  ]
  const category = categories.find(([pattern]) => pattern.test(message))?.[1] ?? 'unclassified'
  const numberHeader = (name: string) => {
    const value = response.headers.get(name)
    return value && /^\d{1,12}$/.test(value) ? Number(value) : null
  }
  console.warn('Public GitHub repository request failed', {
    upstreamStatus: response.status,
    category,
    rateLimitRemaining: numberHeader('x-ratelimit-remaining'),
    rateLimitReset: numberHeader('x-ratelimit-reset'),
    retryAfterSeconds: numberHeader('retry-after'),
  })
}

export async function publicRepositoryList() {
  if(snapshot&&Date.now()<cachedUntil)return {...snapshot,total:snapshot.repositories.length}
  let response:Response
  try { response=await fetch(url,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Evan-Developer-Dashboard'},redirect:'manual'}) }
  catch { throw new ApiError(503,'PUBLIC_GITHUB_UNAVAILABLE','Public GitHub data is temporarily unavailable. Try again shortly.') }
  if (!response.ok) {
    await logPublicGitHubFailure(response)
    throw new ApiError(503, 'PUBLIC_GITHUB_UNAVAILABLE', 'GitHub could not provide public repository data. Try again shortly.')
  }
  const payload:unknown=await response.json().catch(()=>null)
  if(!Array.isArray(payload))throw new ApiError(502,'PUBLIC_GITHUB_RESPONSE','GitHub returned an unreadable public repository list.')
  const fetchedAt=new Date().toISOString()
  const repositories=(payload as Repo[]).filter(r=>r&&r.private===false&&Number.isSafeInteger(r.id)&&typeof r.full_name==='string'&&typeof r.owner?.login==='string').map(r=>({
    id:r.id,owner:r.owner.login,name:r.name,full_name:r.full_name,description:r.description,
    url:typeof r.html_url==='string'?r.html_url:'https://github.com/'+r.full_name,visibility:'public',
    language:r.language,stars:Number(r.stargazers_count)||0,forks:Number(r.forks_count)||0,
    open_issues:Number(r.open_issues_count)||0,default_branch:r.default_branch,created_at:r.created_at,
    updated_at:r.updated_at,pushed_at:r.pushed_at,archived:Number(Boolean(r.archived)),
    fork:Number(Boolean(r.fork)),synced_at:fetchedAt,tags:[],
  }))
  snapshot={repositories,fetchedAt};cachedUntil=Date.now()+300000
  return {...snapshot,total:repositories.length}
}
