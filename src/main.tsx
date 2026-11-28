import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Archive, ArrowDownRight, ArrowRight, Box, ChartNoAxesCombined, ChevronLeft, ChevronRight,
  CircleAlert, CircleHelp, Command, ExternalLink, GitFork, Github, GitPullRequest, LayoutDashboard,
  LockKeyhole, LogOut, Menu, Moon, Play, RefreshCw, Search, Settings, Star, Sun, Tag as TagIcon, X,
} from 'lucide-react'
import { api, RequestError, type Account, type Overview, type Repository, type RepositoryPage, type Tag } from './api'
import { refreshDashboard, refreshLabels, refreshTargets, syncAndRefresh, updateRepositoryAccess, type RefreshTarget, type SyncResult } from './dashboard-sync'
import './style.css'

const navigation = [
  { name: 'Overview', path: 'overview', icon: LayoutDashboard, active: true },
  { name: 'Repositories', path: 'repositories', icon: Box, active: true },
  { name: 'Releases', path: 'releases', icon: TagIcon },
  { name: 'Issues & Pull Requests', path: 'issues', icon: GitPullRequest },
  { name: 'Actions', path: 'actions', icon: Play },
  { name: 'Analytics', path: 'analytics', icon: ChartNoAxesCombined },
  { name: 'Settings', path: 'settings', icon: Settings },
]

const metrics = [
  { key: 'total', label: 'Total repositories', icon: Box, color: 'blue' },
  { key: 'public', label: 'Public repositories', icon: Github, color: 'green' },
  { key: 'private', label: 'Private repositories', icon: LockKeyhole, color: 'violet' },
  { key: 'archived', label: 'Archived repositories', icon: Archive, color: 'slate' },
  { key: 'stars', label: 'Total stars', icon: Star, color: 'gold' },
  { key: 'forks', label: 'Total forks', icon: GitFork, color: 'teal' },
] as const

const number = new Intl.NumberFormat('en')
const date = (value: string | null) => value
  ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'
const shortDate = (value: string | null) => value
  ? new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value)) : '—'
const currentPage = () => location.hash.slice(1) === 'repositories' ? 'repositories' : 'overview'
const loginUrl = '/api/auth/github/start'
const themePreference = () => localStorage.getItem('dashboard-theme') ?? 'system'
const systemTheme = matchMedia('(prefers-color-scheme: dark)')
const isSystemDark = () => systemTheme.matches
function subscribeSystemTheme(onChange: () => void) {
  systemTheme.addEventListener('change', onChange)
  return () => systemTheme.removeEventListener('change', onChange)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The dashboard could not complete the request.'
}

function Notice({ children, kind = 'error' }: { children: ReactNode; kind?: 'error' | 'info' }) {
  return <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}><CircleAlert size={17} /> <div>{children}</div></div>
}

function Brand() {
  return <div className="brand"><span className="brand-icon"><Command size={20} strokeWidth={2.3} /></span>
    <span>Evan <span className="brand-secondary">Developer</span><small>DASHBOARD</small></span></div>
}

function GitHubLink({ repo, children }: { repo: Repository; children: ReactNode }) {
  return <a href={repo.url} className="repo-link" target="_blank" rel="noreferrer" aria-label={`${repo.full_name} on GitHub (opens in a new tab)`}>
    {children} <ExternalLink size={13} />
  </a>
}

function TagBadge({ tag }: { tag: Tag }) {
  return <span className="tag-badge">
    <svg aria-hidden="true" width="9" height="9" viewBox="0 0 9 9"><circle cx="4.5" cy="4.5" r="4" fill={tag.color} /></svg>
    {tag.name}
  </span>
}

function TagManager({ tags, close, refresh }: { tags: Tag[]; close: () => void; refresh: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [editing, setEditing] = useState<Tag>()
  const [name, setName] = useState('')
  const [color, setColor] = useState('#4673D2')
  const [confirm, setConfirm] = useState<Tag>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])

  function edit(tag?: Tag) {
    setEditing(tag)
    setName(tag?.name ?? '')
    setColor(tag?.color ?? '#4673D2')
    setConfirm(undefined)
    setFailure('')
  }

  async function mutate(deleting?: Tag) {
    setFailure('')
    setBusy(true)
    try {
      if (deleting) await api(`/api/tags/${deleting.id}`, { method: 'DELETE' })
      else await api(editing ? `/api/tags/${editing.id}` : '/api/tags', {
        method: editing ? 'PATCH' : 'POST', body: JSON.stringify({ name, color }),
      })
      edit()
      await refresh()
    } catch (error) { setFailure(errorMessage(error)) }
    finally { setBusy(false) }
  }

  return <dialog ref={dialog} onCancel={close} aria-labelledby="tag-manager-title">
    <div className="dialog-header"><h2 id="tag-manager-title">Manage tags</h2>
      <button className="icon-button" aria-label="Close tag manager" onClick={close}><X size={20} /></button></div>
    {failure && <Notice>{failure}</Notice>}
    <form className="tag-form" onSubmit={event => { event.preventDefault(); void mutate() }}>
      <label>Tag name <input required maxLength={60} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>Color <input type="color" value={color} onChange={event => setColor(event.target.value)} /></label>
      <button className="button primary" disabled={busy || !name.trim()}>{editing ? 'Save changes' : 'Create tag'}</button>
      {editing && <button type="button" className="button" disabled={busy} onClick={() => edit()}>Cancel edit</button>}
    </form>
    {tags.length === 0 && <p>No tags yet.</p>}
    <ul className="tag-manager-list">{tags.map(tag => <li key={tag.id}>
      <TagBadge tag={tag} />
      <button className="button" disabled={busy} aria-label={`Edit ${tag.name}`} onClick={() => edit(tag)}>Edit</button>
      <button className="button" disabled={busy} aria-label={`Delete ${tag.name}`} onClick={() => { setConfirm(tag); setFailure('') }}>Delete</button>
    </li>)}</ul>
    {confirm && <div className="tag-form"><p>Delete {confirm.name} and remove it from every repository?</p>
      <button className="button" disabled={busy} onClick={() => void mutate(confirm)}>Delete tag</button>
      <button className="button" disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</button></div>}
  </dialog>
}

function RepoTable({ repositories, onDetails }: { repositories: Repository[]; onDetails?: (repo: Repository) => void }) {
  return <div className="table-wrap" tabIndex={0} role="region" aria-label="Repository table">
    <table><thead><tr>
      <th scope="col">Repository</th><th scope="col">Visibility</th><th scope="col">Language</th>
      <th scope="col">Stars</th><th scope="col">Forks</th><th scope="col">Updated</th>{onDetails && <th scope="col"><span className="sr-only">Details</span></th>}
    </tr></thead><tbody>{repositories.map(repo => <tr key={repo.id}>
      <td><div className="repo-title"><Box size={16} /><GitHubLink repo={repo}>{repo.name}</GitHubLink></div>
        <div className="repo-description">{repo.owner}{repo.description ? ` · ${repo.description}` : ''}</div>
        {!!repo.tags?.length && <div className="tag-badges">{repo.tags.map(tag => <TagBadge key={tag.id} tag={tag} />)}</div>}</td>
      <td><span className={`visibility ${repo.visibility}`}>{repo.visibility}</span></td>
      <td>{repo.language ? <span className="language"><span aria-hidden="true" />{repo.language}</span> : '—'}</td>
      <td>{number.format(repo.stars)}</td><td>{number.format(repo.forks)}</td><td className="nowrap">{shortDate(repo.updated_at)}</td>
      {onDetails && <td><button className="icon-button" aria-label={`Details for ${repo.full_name}`} onClick={() => onDetails(repo)}><ChevronRight size={18} /></button></td>}
    </tr>)}</tbody></table>
  </div>
}

function Details({ repo, tags, close, update }: {
  repo: Repository; tags: Tag[]; close: () => void; update: (repository: Repository) => void
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  async function assign(tagId: number, checked: boolean) {
    setFailure('')
    setBusy(true)
    try {
      await api(`/api/repositories/${repo.id}/tags/${tagId}`, { method: checked ? 'PUT' : 'DELETE' })
      update(await api<Repository>(`/api/repositories/${repo.id}`))
    } catch (error) { setFailure(errorMessage(error)) }
    finally { setBusy(false) }
  }
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  const fields = [
    ['Owner', repo.owner], ['Visibility', repo.visibility], ['Language', repo.language],
    ['Stars', number.format(repo.stars)], ['Forks', number.format(repo.forks)], ['Open issues', number.format(repo.open_issues)],
    ['Default branch', repo.default_branch], ['Created', date(repo.created_at)], ['Updated', date(repo.updated_at)],
    ['Last pushed', date(repo.pushed_at)], ['Archived', repo.archived ? 'Yes' : 'No'], ['Fork', repo.fork ? 'Yes' : 'No'],
  ]
  return <dialog ref={ref} onCancel={close} aria-labelledby="repo-dialog-title">
    <div className="dialog-header"><h2 id="repo-dialog-title">{repo.full_name}</h2><button className="icon-button" aria-label="Close details" onClick={close}><X size={20} /></button></div>
    {repo.description && <p>{repo.description}</p>}
    <dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>)}</dl>
    {failure && <Notice>{failure}</Notice>}
    <fieldset className="tag-choices" disabled={busy}>
      <legend>Repository tags</legend>
      {tags.length ? tags.map(tag => <label key={tag.id}><input type="checkbox" aria-label={tag.name}
        checked={repo.tags.some(item => item.id === tag.id)} onChange={event => void assign(tag.id, event.target.checked)} />
        <TagBadge tag={tag} /></label>) : <p>Create tags from the Repositories page.</p>}
    </fieldset>
    <GitHubLink repo={repo}>{repo.url}</GitHubLink>
  </dialog>
}

function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Box size={25} /></span><h3>{title}</h3><p>{description}</p>{action}</div>
}

function RepositoryList({ snapshot, version, tags, empty, onDetails, onError }: {
  snapshot: Overview | undefined; version: number; tags: Tag[]; empty: ReactNode; onDetails: (repo: Repository) => void; onError: (error: unknown) => void
}) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [selectedTags, setSelectedTags] = useState<number[]>([])
  const [tagMode, setTagMode] = useState('any')
  useEffect(() => {
    setSelectedTags(previous => {
      const remaining = previous.filter(id => tags.some(tag => tag.id === id))
      return remaining.length === previous.length ? previous : remaining
    })
  }, [tags])
  const [filters, setFilters] = useState({ visibility: '', archived: '', fork: '', language: '', sort: 'updated' })
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<RepositoryPage>()
  const [failure, setFailure] = useState('')
  const [attempt, setAttempt] = useState(0)
  const expired = snapshot?.accessExpired
  useEffect(() => {
    const timeout = setTimeout(() => { setQuery(search); setPage(1) }, 250)
    return () => clearTimeout(timeout)
  }, [search])
  useEffect(() => {
    if (expired) return
    const controller = new AbortController()
    const params = new URLSearchParams({ q: query, page: String(page) })
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value) })
    if (selectedTags.length) {
      params.set('tagMode', tagMode)
      selectedTags.forEach(id => params.append('tag', String(id)))
    }
    setFailure('')
    setResult(undefined)
    api<RepositoryPage>(`/api/repositories?${params}`, { signal: controller.signal })
      .then(data => {
        if (!controller.signal.aborted) {
          const last = Math.max(1, Math.ceil(data.total / data.pageSize))
          if (page > last) setPage(last)
          else setResult(data)
        }
      }).catch(error => {
        if (!controller.signal.aborted) {
          setFailure(errorMessage(error))
          if (error instanceof RequestError && error.code === 'UNAUTHENTICATED') onError(error)
        }
      })
    return () => controller.abort()
  }, [query, filters, page, version, expired, attempt, onError, selectedTags, tagMode])

  function filter(key: keyof typeof filters, value: string) {
    setPage(1)
    setFilters(previous => ({ ...previous, [key]: value }))
  }

  const selects = [
    { key: 'visibility', label: 'Visibility', options: [['', 'All visibility'], ['public', 'Public'], ['private', 'Private'], ['internal', 'Internal']] },
    { key: 'archived', label: 'Status', options: [['', 'All statuses'], ['false', 'Active'], ['true', 'Archived']] },
    { key: 'fork', label: 'Repository type', options: [['', 'All types'], ['false', 'Original'], ['true', 'Fork']] },
    { key: 'language', label: 'Language', options: [['', 'All languages'], ...(snapshot?.languages ?? []).map(value => [value, value])] },
    { key: 'sort', label: 'Sort by', options: [['updated', 'Recently updated'], ['created', 'Recently created'], ['name', 'Repository name'], ['stars', 'Most stars'], ['forks', 'Most forks']] },
  ] as const

  if (expired) return <section className="panel">{empty}</section>
  return <section className="panel">
    <div className="filters">
      <label className="search"><Search size={17} /><span className="sr-only">Search repositories</span>
        <input placeholder="Search repositories…" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} /></label>
      {selects.map(({ key, label, options }) => <label key={key}><span className="sr-only">{label}</span>
        <select value={filters[key]} onChange={event => filter(key, event.target.value)}>
          {options.map(([value, text]) => <option value={value} key={value}>{text}</option>)}
        </select></label>)}
    </div>
    {!!tags.length && <details className="tag-filter">
      <summary>Filter by tags{selectedTags.length ? ` (${selectedTags.length})` : ''}</summary>
      <label>Match <select value={tagMode} onChange={event => { setTagMode(event.target.value); setPage(1) }}>
        <option value="any">Any selected tag</option><option value="all">All selected tags</option>
      </select></label>
      <fieldset className="tag-choices"><legend className="sr-only">Filter by tags</legend>
        {tags.map(tag => <label key={tag.id}><input type="checkbox" aria-label={tag.name}
          checked={selectedTags.includes(tag.id)} disabled={!selectedTags.includes(tag.id) && selectedTags.length >= 100}
          onChange={event => {
            const checked = event.target.checked
            setSelectedTags(previous => checked ? [...previous, tag.id] : previous.filter(id => id !== tag.id))
            setPage(1)
          }} /><TagBadge tag={tag} /></label>)}
      </fieldset>
    </details>}
    {failure ? <div className="panel-body"><Notice>{failure} <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Try again</button></Notice></div>
      : !result ? <div className="panel-body" role="status">Loading repositories…</div>
      : result.total ? <>
        <RepoTable repositories={result.repositories} onDetails={onDetails} />
        <div className="pagination"><span>{(result.page - 1) * result.pageSize + 1}–{Math.min(result.page * result.pageSize, result.total)} of {number.format(result.total)}</span>
          <div><button className="button" disabled={page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={17} /> Previous</button>
            <button className="button" disabled={page * result.pageSize >= result.total} onClick={() => setPage(value => value + 1)}>Next <ChevronRight size={17} /></button></div>
        </div>
      </> : snapshot?.stats.total ? <Empty title="No matching repositories" description="Try another search or clear the filters."
        action={<button className="button" onClick={() => { setSearch(''); setQuery(''); setPage(1); setSelectedTags([]); setTagMode('any'); setFilters({ visibility: '', archived: '', fork: '', language: '', sort: 'updated' }) }}>Clear filters</button>} /> : empty}
  </section>
}

function PublicDemo({ themeToggle }: { themeToggle: ReactNode }) {
  const [repos,setRepos]=useState<Repository[]>()
  const [error,setError]=useState('')
  const [query,setQuery]=useState('')
  const [sort,setSort]=useState('updated')
  useEffect(()=>{let active=true;api<{repositories:Repository[]}>('/api/public/repositories').then(data=>{if(active)setRepos(data.repositories)}).catch(e=>{if(active)setError(errorMessage(e))});return()=>{active=false}},[])
  const filtered=(repos??[]).filter(r=>(r.full_name+' '+(r.description??'')).toLowerCase().includes(query.toLowerCase())).sort((a,b)=>sort==='name'?a.full_name.localeCompare(b.full_name):sort==='stars'?b.stars-a.stars:new Date(b.updated_at??0).getTime()-new Date(a.updated_at??0).getTime())
  const stats=[['Public repositories',repos?.length??0],['Stars',(repos??[]).reduce((n,r)=>n+r.stars,0)],['Forks',(repos??[]).reduce((n,r)=>n+r.forks,0)]]
  return <div className="signin"><header><Brand/>{themeToggle}</header><main className="content public-demo">
    <div className="page-heading"><div><h1>Evan Developer Dashboard · Public Demo</h1><p>Explore Evan Windproof’s public GitHub projects. No sign-in required.</p></div><a className="button primary" href="/">Sign in to personal dashboard <ArrowRight size={16}/></a></div>
    <div className="sync-info"><span className="status-dot synced"/>PUBLIC · READ ONLY</div>
    <Notice kind="info">This demo displays public repository metadata only. Private repositories, personal tags and account controls are not available.</Notice>
    {error&&<Notice>{error}</Notice>}
    {!repos&&!error&&<section className="panel panel-body">Loading public repositories…</section>}
    {repos&&<><div className="metrics">{stats.map(([label,value])=><div className="metric" key={label}><strong>{number.format(Number(value))}</strong><span>{label}</span></div>)}</div>
      <section className="panel"><div className="filters"><label className="search"><Search size={17}/><input aria-label="Search public repositories" placeholder="Search repositories…" value={query} onChange={e=>setQuery(e.target.value)}/></label><label><span className="sr-only">Sort by</span><select value={sort} onChange={e=>setSort(e.target.value)}><option value="updated">Recently updated</option><option value="name">Name</option><option value="stars">Most stars</option></select></label></div>
      <RepoTable repositories={filtered}/></section></>}
    <footer className="content-footer"><LockKeyhole size={15}/> Public read-only preview · <a href="/">Open personal dashboard</a></footer>
  </main></div>
}
function App() {
  const demoMode = location.pathname === '/demo' || location.pathname === '/demo/'
  const [account, setAccount] = useState<Account | null>()
  const [tags, setTags] = useState<Tag[]>([])
  const [managingTags, setManagingTags] = useState(false)
  const [page, setPage] = useState(currentPage)
  const [theme, setTheme] = useState(themePreference)
  const systemDark = useSyncExternalStore(subscribeSystemTheme, isSystemDark)
  const [menu, setMenu] = useState(false)
  const [{ snapshot, lastSync }, dispatchAccess] = useReducer(updateRepositoryAccess, {})
  const [installations, setInstallations] = useState<number>()
  const [version, setVersion] = useState(0)
  const [detail, setDetail] = useState<Repository>()
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState<RequestError>()
  const [syncResult, setSyncResult] = useState<SyncResult>()
  const [refreshFailures, setRefreshFailures] = useState<Partial<Record<RefreshTarget, string>>>({})
  const refreshGeneration = useRef({ overview: 0, installations: 0, tags: 0 })
  const [cooldown, setCooldown] = useState(0)
  const [clock, setClock] = useState(Date.now)
  const [callback] = useState(() => new URLSearchParams(location.search))
  const [message, setMessage] = useState(() => {
    if (callback.get('github') === 'installed') return 'GitHub App installation verified. Sync repositories to load your authorized data.'
    if (callback.get('github') === 'requested') return 'Installation requested. Sync after an organization administrator approves it.'
    return ''
  })
  const [callbackError, setCallbackError] = useState(callback.has('login-error')
    ? 'GitHub sign-in did not complete. Start sign-in again.'
    : callback.has('install-error') ? 'Installation could not be verified. Reopen the installation flow or sync to discover existing access.' : '')

  const report = useCallback((error: unknown) => {
    if (error instanceof RequestError) {
      if (error.code === 'UNAUTHENTICATED') setAccount(null)
      if (error.retryAfter) setCooldown(Date.now() + error.retryAfter * 1000)
      setFailure(error)
    } else setFailure(new RequestError('UNKNOWN', errorMessage(error)))
  }, [])

  const loadAccount = useCallback(async () => {
    try {
      setAccount(await api<Account>('/api/me'))
    } catch (error) {
      setAccount(null)
      if (!(error instanceof RequestError && error.code === 'UNAUTHENTICATED')) report(error)
    }
  }, [report])

  useEffect(() => { if(!demoMode) void loadAccount() }, [demoMode,loadAccount])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('dashboard-theme', theme)
  }, [theme])
  useEffect(() => {
    const navigate = () => { setPage(currentPage()); setMenu(false) }
    window.addEventListener('hashchange', navigate)
    if (location.search) history.replaceState(null, '', location.pathname + location.hash)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])
  const reload = useCallback(async (targets: RefreshTarget[] = refreshTargets) => {
    const generation = { ...refreshGeneration.current }
    for (const target of targets) generation[target] = ++refreshGeneration.current[target]
    const current = (target: RefreshTarget) => generation[target] === refreshGeneration.current[target]
    await refreshDashboard(targets, {
      overview: async () => {
        const data = await api<Overview>('/api/overview')
        if (!current('overview')) return
        dispatchAccess({ type: 'overview', snapshot: data })
        if (data.accessExpired) setDetail(undefined)
      },
      installations: async () => {
        const links = await api<unknown[]>('/api/github/installations')
        if (current('installations')) setInstallations(links.length)
      },
      tags: async () => {
        const nextTags = await api<Tag[]>('/api/tags')
        if (current('tags')) setTags(nextTags)
      },
    }, (target, result) => {
      if (!current(target)) return
      if (result.status === 'rejected' && result.reason instanceof RequestError && result.reason.code === 'UNAUTHENTICATED') {
        setAccount(null)
      }
      setRefreshFailures(previous => ({
        ...previous, [target]: result.status === 'rejected' ? errorMessage(result.reason) : undefined,
      }))
    })
  }, [])
  const refreshWorkspace = useCallback(async () => {
    setVersion(value => value + 1)
    await reload()
  }, [reload])
  useEffect(() => {
    if (account) void refreshWorkspace()
    else {
      for (const target of refreshTargets) refreshGeneration.current[target]++
      dispatchAccess({ type: 'reset' }); setInstallations(undefined); setDetail(undefined); setTags([]); setManagingTags(false)
      setRefreshFailures({}); setSyncResult(undefined)
    }
  }, [account, refreshWorkspace])
  useEffect(() => {
    if (!snapshot?.lastSync || snapshot.accessExpired) return
    const snapshotTime = snapshot.lastSync
    const remaining = new Date(snapshotTime).getTime() + 15 * 60_000 - Date.now()
    const timeout = setTimeout(() => {
      dispatchAccess({ type: 'expire', lastSync: snapshotTime })
      setDetail(undefined)
    }, Math.max(0, remaining))
    return () => clearTimeout(timeout)
  }, [snapshot?.lastSync, snapshot?.accessExpired])
  useEffect(() => {
    if (cooldown <= Date.now()) return
    setClock(Date.now())
    const timer = setInterval(() => {
      setClock(Date.now())
      if (Date.now() >= cooldown) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [cooldown])

  async function refreshAfterSync() {
    // Prior rows can include repositories revoked by this sync.
    dispatchAccess({ type: 'invalidate' })
    setDetail(undefined)
    await refreshWorkspace()
  }

  async function action(kind: 'sync' | 'install' | 'logout') {
    setBusy(kind)
    setFailure(undefined)
    setCallbackError('')
    setMessage('')
    if (kind === 'sync') setSyncResult(undefined)
    try {
      if (kind === 'install') {
        const { url } = await api<{ url: string }>('/api/github/installations/install-url')
        location.assign(url)
      } else if (kind === 'logout') {
        await api('/api/auth/logout', { method: 'POST' })
        setAccount(null)
      } else {
        await syncAndRefresh(result => {
          setSyncResult(result)
          dispatchAccess({ type: 'sync', lastSync: result.lastSync })
          if (result.retryAfter) setCooldown(Date.now() + result.retryAfter * 1000)
        }, refreshAfterSync)
      }
    } catch (error) {
      report(error)
      if (kind === 'sync') await refreshAfterSync()
    } finally {
      setBusy('')
    }
  }

  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  const toggleTheme = <button className="icon-button theme-toggle" aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    title={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme(dark ? 'light' : 'dark')}>{dark ? <Sun size={19} /> : <Moon size={19} />}</button>

  if(demoMode) return <PublicDemo themeToggle={toggleTheme}/>

  if (!account) return <main className="signin">
    <header><Brand />{toggleTheme}</header>
    <section className="signin-card">
      <span className="signin-icon"><Github size={30} /></span>
      <h1>Your GitHub repositories, in one place.</h1>
      <p>Track repository activity, find projects across your GitHub installations, and keep metadata up to date.</p>
      {callbackError && <Notice>{callbackError}</Notice>}
      {failure && <Notice>{failure.message} <button className="text-button" onClick={() => { setFailure(undefined); void loadAccount() }}>Try again</button></Notice>}
      {account === undefined ? <p role="status">Checking your session…</p>
        : <a className="button primary" href={loginUrl}><Github size={19} /> Continue with GitHub <ArrowRight size={17} /></a>}
      <a className="button signin-demo-link" href="/demo"><Github size={17}/> Explore public demo <ArrowRight size={16}/></a>
      <p className="signin-note"><LockKeyhole size={15} /> Repository metadata access only</p>
    </section>
  </main>

  const wait = Math.max(0, Math.ceil((cooldown - clock) / 1000))
  const syncButton = <button className="button primary" disabled={Boolean(busy) || wait > 0} onClick={() => void action('sync')}>
    <RefreshCw size={17} className={busy === 'sync' ? 'spin' : ''} />
    {busy === 'sync' ? 'Syncing repositories…' : wait ? `Sync available in ${wait}s` : 'Sync Repositories'}
  </button>
  const installButton = <button className="button" disabled={Boolean(busy)} onClick={() => void action('install')}>
    <Github size={17} /> {busy === 'install' ? 'Opening GitHub…' : 'Install GitHub App'}
  </button>
  const data = snapshot?.accessExpired ? undefined : snapshot
  const syncMessage = syncResult && (syncResult.status === 'complete'
    ? `Synchronized ${number.format(syncResult.total)} ${syncResult.total === 1 ? 'repository' : 'repositories'}.`
    : `Sync partially completed. Updated ${number.format(syncResult.total)} repositories across ${syncResult.installations.succeeded} installations. ${syncResult.installations.failed} installations could not be refreshed.`)
  const empty = snapshot?.accessExpired
    ? <Empty title="Repository access needs to be refreshed" description="Sync repositories to verify your current GitHub access." action={syncButton} />
    : !snapshot || installations === undefined
      ? (refreshFailures.overview || refreshFailures.installations) ? <Empty title="Repository data is unavailable"
        description="Retry the failed dashboard refresh to load this view." />
        : <div className="panel-body" role="status">Loading your workspace…</div>
      : !installations ? <Empty title="Connect a GitHub installation" description="Install the GitHub App on your personal account or an organization. If it is already installed, sync to discover it." action={installButton} />
      : !snapshot.lastSync ? <Empty title="Sync your repositories" description="Your installation is connected. Run your first sync to load repository metadata." action={syncButton} />
      : <Empty title="No authorized repositories" description="Check the repositories selected for the GitHub App and your account’s access, then sync again." action={installButton} />

  return <div className="app-shell">
    <a className="skip-link" href="#main" onClick={event => {
      event.preventDefault()
      document.getElementById('main')?.focus()
    }}>Skip to main content</a>
    <aside className={`sidebar ${menu ? 'open' : ''}`} id="sidebar">
      <Brand />
      <nav aria-label="Main navigation">
        {navigation.map(({ name, path, icon: Icon, active }) => active
          ? <a key={path} href={`#${path}`} aria-current={page === path ? 'page' : undefined} className={`nav-item ${page === path ? 'selected' : ''}`} onClick={() => setMenu(false)}><Icon size={18} />{name}</a>
          : <div key={path} className="nav-item planned"><Icon size={18} /><span>{name}</span><small>Coming soon</small></div>)}
      </nav>
      <div className="sidebar-footer"><div className="account">
        {account.avatar_url ? <img src={account.avatar_url} alt="" width="34" height="34" /> : <Github size={23} />}
        <div><strong>{account.display_name ?? account.login}</strong><span>@{account.login}</span></div>
        <button className="icon-button" aria-label="Sign out" title="Sign out" disabled={Boolean(busy)} onClick={() => void action('logout')}><LogOut size={16} /></button>
      </div></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Toggle navigation" aria-expanded={menu}
          aria-controls="sidebar" onClick={() => setMenu(value => !value)}>{menu ? <X size={20} /> : <Menu size={20} />}</button>
          <span>Workspace</span><ChevronRight size={14} /><strong>{page === 'overview' ? 'Overview' : 'Repositories'}</strong></div>
        {toggleTheme}
      </header>
      <main className="content" id="main" tabIndex={-1}>
        <div className="page-heading">
          <div><h1>{page === 'overview' ? 'Overview' : 'Repositories'}</h1>
            <p>{page === 'overview' ? 'A snapshot of your authorized GitHub repositories.' : 'Search and browse repositories you’ve authorized on GitHub.'}</p></div>
          <div className="actions">{page === 'repositories' && <button className="button" onClick={() => setManagingTags(true)}>Manage tags</button>}{installButton}{syncButton}</div>
        </div>
        <div className="sync-info"><span className={`status-dot ${data?.lastSync ? 'synced' : ''}`} />
          <span>{lastSync ? `Repository access last refreshed · ${date(lastSync)}` : lastSync === null
            ? 'Repository access has never been refreshed' : 'Repository access history is unavailable'}</span></div>
        {message && <Notice kind="info">{message}</Notice>}
        {syncMessage && <Notice kind="info">{syncMessage}</Notice>}
        {refreshTargets.map(target => refreshFailures[target] && <Notice key={target}>
          {refreshLabels[target]} refresh failed. {refreshFailures[target]}{' '}
          <button className="text-button" disabled={Boolean(busy)} onClick={() => void reload([target])}>
            Retry {refreshLabels[target].toLowerCase()}
          </button>
        </Notice>)}
        {callbackError && <Notice>{callbackError}</Notice>}
        {failure && <Notice>{failure.message} {['GITHUB_REAUTH', 'GITHUB_CREDENTIALS_UNREADABLE'].includes(failure.code) && <a href={loginUrl}>Reconnect GitHub</a>}</Notice>}
        {page === 'overview' ? <>
          <div className="metrics">{metrics.map(({ key, label, icon: Icon, color }) => <div className="metric" key={key}>
            <span className={`metric-icon ${color}`}><Icon size={17} /></span>
            <strong>{data?.lastSync ? number.format(data.stats[key]) : '—'}</strong><span>{label}</span>
          </div>)}</div>
          <section className="panel recent">
            <div className="panel-header"><div><h2>Recently updated</h2><p>Latest activity across your repositories.</p></div>
              <a className="button" href="#repositories">All repositories <ArrowDownRight size={16} /></a></div>
            {data?.recent.length ? <RepoTable repositories={data.recent} onDetails={setDetail} /> : empty}
          </section>
        </> : <RepositoryList snapshot={snapshot} version={version} tags={tags} empty={empty} onDetails={setDetail} onError={report} />}
        <footer className="content-footer"><CircleHelp size={15} /> Repository access is managed through your GitHub App installations.</footer>
      </main>
    </div>
    {detail && <Details repo={detail} tags={tags} close={() => setDetail(undefined)} update={repository => {
      setDetail(previous => previous?.id === repository.id ? repository : previous)
      void refreshWorkspace()
    }} />}
    {managingTags && <TagManager tags={tags} close={() => setManagingTags(false)} refresh={refreshWorkspace} />}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
