-- A page is the one thing Closedhand makes (lib/page-media.js): what was a
-- canvas is now a piece on a page, so the canvases and the web chat's
-- references to them go.
DELETE FROM web_messages WHERE content LIKE '[canvas:%';
DROP TABLE IF EXISTS canvases;
