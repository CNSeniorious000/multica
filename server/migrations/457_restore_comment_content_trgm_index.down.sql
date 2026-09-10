-- Re-drop the trgm index to return to the post-455 state.
DROP INDEX CONCURRENTLY IF EXISTS idx_comment_content_trgm;
