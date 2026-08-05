import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolutePath, resolveAppPath, resolveSqlitePath, sqlitePathFromUrl } from "./datasource.ts";

// `resolveSqlitePath` is the single source of truth for turning a datasource `url` into its
// on-disk SQLite path (absolute when `root` is absolute, relative when `root` is relative, e.g.
// `root === "."`), shared by `openSqliteSource` (which opens the file) and `provisionSqlite`
// (which logs `path`). These guard that the two can never drift: the logged path must be exactly
// the path that was opened.
test("resolveSqlitePath joins a relative url verbatim against root", () => {
  assert.equal(resolveSqlitePath("/srv/app", "file:./db/app.db"), "/srv/app/./db/app.db");
  assert.equal(resolveSqlitePath("/srv/app", "sqlite:db/app.db"), "/srv/app/db/app.db");
  assert.equal(resolveSqlitePath(".", "sqlite:db/app.db"), "./db/app.db");
});

test("resolveSqlitePath passes an absolute path through unchanged", () => {
  assert.equal(resolveSqlitePath("/srv/app", "file:/var/data/app.db"), "/var/data/app.db");
});

test("resolveSqlitePath honours Windows absolute paths (drive-letter + UNC) as-is", () => {
  // A Node host on Windows can hand us a drive-letter or UNC absolute path; it must NOT be
  // treated as relative and prefixed with `root`.
  assert.equal(resolveSqlitePath("/srv/app", "file:C:\\data\\app.db"), "C:\\data\\app.db");
  assert.equal(resolveSqlitePath("/srv/app", "sqlite:C:/data/app.db"), "C:/data/app.db");
  assert.equal(
    resolveSqlitePath("/srv/app", "file:\\\\server\\share\\app.db"),
    "\\\\server\\share\\app.db",
  );
});

test("isAbsolutePath recognises POSIX, drive-letter and UNC roots (and rejects relative)", () => {
  assert.equal(isAbsolutePath("/var/data/app.db"), true);
  assert.equal(isAbsolutePath("C:\\data\\app.db"), true);
  assert.equal(isAbsolutePath("c:/data/app.db"), true);
  assert.equal(isAbsolutePath("\\\\server\\share\\app.db"), true);
  assert.equal(isAbsolutePath("db/app.db"), false);
  assert.equal(isAbsolutePath("./db/app.db"), false);
  assert.equal(isAbsolutePath("C:relative.db"), false); // drive-relative, no root separator
});

test("resolveAppPath trims a trailing separator of either kind off root before joining", () => {
  assert.equal(resolveAppPath("/srv/app/", "app.db"), "/srv/app/app.db");
  assert.equal(resolveAppPath("C:\\srv\\app\\", "app.db"), "C:\\srv\\app/app.db");
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
