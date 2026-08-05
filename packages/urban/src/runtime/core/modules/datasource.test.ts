import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSqlitePath, sqlitePathFromUrl } from "./datasource.ts";

// `resolveSqlitePath` is the single source of truth for turning a datasource `url` into the
// absolute on-disk SQLite path, shared by `openSqliteSource` (which opens the file) and
// `provisionSqlite` (which logs `path`). These guard that the two can never drift: the logged
// path must be exactly the path that was opened.
test("resolveSqlitePath joins a relative url verbatim against root", () => {
  assert.equal(resolveSqlitePath("/srv/app", "file:./db/app.db"), "/srv/app/./db/app.db");
  assert.equal(resolveSqlitePath("/srv/app", "sqlite:db/app.db"), "/srv/app/db/app.db");
  assert.equal(resolveSqlitePath(".", "sqlite:db/app.db"), "./db/app.db");
});

test("resolveSqlitePath passes an absolute path through unchanged", () => {
  assert.equal(resolveSqlitePath("/srv/app", "file:/var/data/app.db"), "/var/data/app.db");
});

test("resolveSqlitePath strips a trailing slash on root before joining", () => {
  assert.equal(resolveSqlitePath("/srv/app/", "sqlite:app.db"), "/srv/app/app.db");
});

test("resolveSqlitePath resolves the same path openSqliteSource would open", () => {
  const root = "/srv/app";
  const url = "file:./db/app.db";
  const bare = sqlitePathFromUrl(url);
  assert.equal(resolveSqlitePath(root, url), `${root}/${bare}`);
});
