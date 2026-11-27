SELECT u.github_id, t.name, t.color, t.created_at,
  r.id AS repository_id, r.full_name
FROM tags t
JOIN users u ON u.id = t.user_id
LEFT JOIN repository_tags rt ON rt.user_id = t.user_id AND rt.tag_id = t.id
LEFT JOIN repositories r ON r.id = rt.repository_id
ORDER BY u.github_id, t.id, r.id;
