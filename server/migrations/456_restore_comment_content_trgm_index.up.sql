-- Restore the trgm GIN on comment content that migration 455 dropped.
--
-- 455 dropped idx_comment_content_trgm on the premise that SearchIssues no
-- longer reads it (MUL-7055's candidate-first pipeline scanned comments by
-- workspace and evaluated content during aggregation). MUL-7055 was
-- reverted (commit e5f59889d) back to the OR-of-LIKE + EXISTS path that DOES
-- read this index, and the search rewrite on this branch (perf(search): use
-- trgm GIN bitmap scans via UNION ALL candidate set) leans on it directly:
-- the comment candidate branch is `LOWER(c.content) LIKE $phraseContains` and
-- needs the GIN bitmap scan to stay sub-100ms. Without the index that branch
-- degrades to a workspace-scoped seq scan over the comment table.
--
-- Keep this single-statement — concurrent index DDL cannot run inside a
-- transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comment_content_trgm
    ON comment USING gin (LOWER(content) gin_trgm_ops);
