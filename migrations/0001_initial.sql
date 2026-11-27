CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  avatar_url TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_sync TEXT,
  sync_started INTEGER,
  sync_retry_at INTEGER,
  sync_lock TEXT
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE github_credentials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted TEXT NOT NULL,
  refresh_lock_until INTEGER
);

CREATE TABLE oauth_states (
  hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'install')),
  session_hash TEXT REFERENCES sessions(id_hash) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);
CREATE INDEX oauth_states_session ON oauth_states(session_hash);

CREATE TABLE installations (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  repository_selection TEXT NOT NULL
);

CREATE TABLE user_installations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, installation_id)
);
CREATE INDEX user_installations_reverse ON user_installations(installation_id, user_id);

CREATE TABLE repositories (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private', 'internal')),
  language TEXT,
  stars INTEGER NOT NULL,
  forks INTEGER NOT NULL,
  open_issues INTEGER NOT NULL,
  default_branch TEXT,
  created_at TEXT,
  updated_at TEXT,
  pushed_at TEXT,
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  fork INTEGER NOT NULL CHECK (fork IN (0, 1)),
  synced_at TEXT NOT NULL
);

CREATE TABLE installation_repositories (
  installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  PRIMARY KEY (installation_id, repository_id)
);
CREATE INDEX installation_repositories_reverse ON installation_repositories(repository_id);

-- Organization users can see different subsets of a shared installation.
CREATE TABLE user_repository_access (
  user_id INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, installation_id, repository_id),
  FOREIGN KEY (user_id, installation_id)
    REFERENCES user_installations(user_id, installation_id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id, repository_id)
    REFERENCES installation_repositories(installation_id, repository_id) ON DELETE CASCADE
);
CREATE INDEX user_repository_access_repo ON user_repository_access(user_id, repository_id);
CREATE INDEX user_repository_access_installation ON user_repository_access(installation_id, repository_id);
