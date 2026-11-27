import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Archive, ArrowDownRight, ArrowRight, Box, ChartNoAxesCombined, ChevronLeft, ChevronRight,
  CircleAlert, CircleHelp, Command, ExternalLink, GitFork, Github, GitPullRequest, LayoutDashboard,
  LockKeyhole, LogOut, Menu, Moon, Play, RefreshCw, Search, Settings, Star, Sun, Tag, X,
} from 'lucide-react'
import { api, RequestError, type Account, type Overview, type Repository, type RepositoryPage } from './api'
import './style.css'

const navigation = [
  { name: 'Overview', path: 'overview', icon: LayoutDashboard, active: true },
  { name: 'Repositories', path: 'repositories', icon: Box, active: true },
  { name: 'Releases', path: 'releases', icon: Tag },
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

function RepoTable({ repositories, onDetails }: { repositories: Repository[]; onDetails: (repo: Repository) => void }) {
  return <div className="table-wrap" tabIndex={0} role="region" aria-label="Repository table">
    <table><thead><tr>
      <th scope="col">Repository</th><th scope="col">Visibility</th><th scope="col">Language</th>
      <th scope="col">Stars</th><th scope="col">Forks</th><th scope="col">Updated</th><th scope="col"><span className="sr-only">Details</span></th>
    </tr></thead><tbody>{repositories.map(repo => <tr key={repo.id}>
      <td><div className="repo-title"><Box size={16} /><GitHubLink repo={repo}>{repo.name}</GitHubLink></div>
        <div className="repo-description">{repo.owner}{repo.description ? ` · ${repo.description}` : ''}</div></td>
      <td><span className={`visibility ${repo.visibility}`}>{repo.visibility}</span></td>
      <td>{repo.language ? <span className="language"><span aria-hidden="true" />{repo.language}</span> : '—'}</td>
      <td>{number.format(repo.stars)}</td><td>{number.format(repo.forks)}</td><td className="nowrap">{shortDate(repo.updated_at)}</td>
      <td><button className="icon-button" aria-label={`Details for ${repo.full_name}`} onClick={() => onDetails(repo)}><ChevronRight size={18} /></button></td>
    </tr>)}</tbody></table>
  </div>
}

function Details({ repo, close }: { repo: Repository; close: () => void }) {
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
    <GitHubLink repo={repo}>Open on GitHub</GitHubLink>
  </dialog>
}

function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Box size={25} /></span><h3>{title}</h3><p>{description}</p>{action}</div>
}

function RepositoryList({ snapshot, version, empty, onDetails, onError }: {
  snapshot: Overview | undefined; version: number; empty: ReactNode; onDetails: (repo: Repository) => void; onError: (error: unknown) => void
}) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
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
  }, [query, filters, page, version, expired, attempt, onError])

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
    {failure ? <div className="panel-body"><Notice>{failure} <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Try again</button></Notice></div>
      : !result ? <div className="panel-body" role="status">Loading repositories…</div>
      : result.total ? <>
        <RepoTable repositories={result.repositories} onDetails={onDetails} />
        <div className="pagination"><span>{(result.page - 1) * result.pageSize + 1}–{Math.min(result.page * result.pageSize, result.total)} of {number.format(result.total)}</span>
          <div><button className="button" disabled={page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={17} /> Previous</button>
            <button className="button" disabled={page * result.pageSize >= result.total} onClick={() => setPage(value => value + 1)}>Next <ChevronRight size={17} /></button></div>
        </div>
      </> : snapshot?.stats.total ? <Empty title="No matching repositories" description="Try another search or clear the filters."
        action={<button className="button" onClick={() => { setSearch(''); setQuery(''); setPage(1); setFilters({ visibility: '', archived: '', fork: '', language: '', sort: 'updated' }) }}>Clear filters</button>} /> : empty}
  </section>
}

function App() {
  const [account, setAccount] = useState<Account | null>()
  const [page, setPage] = useState(currentPage)
  const [theme, setTheme] = useState(themePreference)
  const systemDark = useSyncExternalStore(subscribeSystemTheme, isSystemDark)
  const [menu, setMenu] = useState(false)
  const [snapshot, setSnapshot] = useState<Overview>()
  const [installations, setInstallations] = useState<number>()
  const [version, setVersion] = useState(0)
  const [detail, setDetail] = useState<Repository>()
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState<RequestError>()
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

  useEffect(() => { void loadAccount() }, [loadAccount])
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
  const reload = useCallback(async () => {
    const [data, links] = await Promise.all([
      api<Overview>('/api/overview'), api<unknown[]>('/api/github/installations'),
    ])
    setSnapshot(data)
    setInstallations(links.length)
    setVersion(value => value + 1)
    if (data.accessExpired) setDetail(undefined)
  }, [])
  useEffect(() => {
    if (account) void reload().catch(report)
    else { setSnapshot(undefined); setInstallations(undefined); setDetail(undefined) }
  }, [account, reload, report])
  useEffect(() => {
    if (!snapshot?.lastSync || snapshot.accessExpired) return
    const remaining = new Date(snapshot.lastSync).getTime() + 15 * 60_000 - Date.now()
    const timeout = setTimeout(() => {
      setSnapshot(previous => previous ? { ...previous, accessExpired: true, recent: [] } : previous)
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

  async function action(kind: 'sync' | 'install' | 'logout') {
    setBusy(kind)
    setFailure(undefined)
    setCallbackError('')
    setMessage('')
    try {
      if (kind === 'install') {
        const { url } = await api<{ url: string }>('/api/github/installations/install-url')
        location.assign(url)
      } else if (kind === 'logout') {
        await api('/api/auth/logout', { method: 'POST' })
        setAccount(null)
      } else {
        const result = await api<{ total: number }>('/api/repositories/sync', { method: 'POST' })
        await reload()
        setMessage(`Synchronized ${number.format(result.total)} ${result.total === 1 ? 'repository' : 'repositories'}.`)
      }
    } catch (error) {
      report(error)
      if (kind === 'sync') await reload().catch(() => undefined)
    } finally {
      setBusy('')
    }
  }

  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  const toggleTheme = <button className="icon-button theme-toggle" aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    title={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme(dark ? 'light' : 'dark')}>{dark ? <Sun size={19} /> : <Moon size={19} />}</button>

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
  const empty = snapshot?.accessExpired
    ? <Empty title="Repository access needs to be refreshed" description="Sync repositories to verify your current GitHub access." action={syncButton} />
    : !snapshot || installations === undefined
      ? failure ? <Empty title="Repository data is unavailable" description="Try loading your dashboard again."
        action={<button className="button" onClick={() => { setFailure(undefined); void reload().catch(report) }}>Try again</button>} />
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
          <div className="actions">{installButton}{syncButton}</div>
        </div>
        <div className="sync-info"><span className={`status-dot ${data?.lastSync ? 'synced' : ''}`} />
          <span>{snapshot?.lastSync ? `Last successful sync · ${date(snapshot.lastSync)}` : 'No successful sync yet'}</span></div>
        {message && <Notice kind="info">{message}</Notice>}
        {callbackError && <Notice>{callbackError}</Notice>}
        {failure && <Notice>{failure.message} {failure.code === 'GITHUB_REAUTH' && <a href={loginUrl}>Reconnect GitHub</a>}</Notice>}
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
        </> : <RepositoryList snapshot={snapshot} version={version} empty={empty} onDetails={setDetail} onError={report} />}
        <footer className="content-footer"><CircleHelp size={15} /> Repository access is managed through your GitHub App installations.</footer>
      </main>
    </div>
    {detail && <Details repo={detail} close={() => setDetail(undefined)} />}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
