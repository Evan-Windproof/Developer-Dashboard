CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, name_key),
  UNIQUE (user_id, id)
);

CREATE TABLE repository_tags (
  user_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, repository_id, tag_id),
  FOREIGN KEY (user_id, tag_id) REFERENCES tags(user_id, id) ON DELETE CASCADE
);
CREATE INDEX repository_tags_by_tag ON repository_tags(user_id, tag_id, repository_id);
CREATE INDEX repository_tags_by_repository ON repository_tags(repository_id);
