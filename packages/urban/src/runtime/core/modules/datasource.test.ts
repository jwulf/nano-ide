import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolutePath, MIGRATIONS_TABLE, parentDir, resolveAppPath, resolveSqlitePath, sqlitePathFromUrl } from "./datasource.ts";

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
  assert.equal(isAbsolutePath("\\data\\app.db"), true); // Windows drive-root, single leading backslash
  assert.equal(isAbsolutePath("db/app.db"), false);
  assert.equal(isAbsolutePath("./db/app.db"), false);
  assert.equal(isAbsolutePath("C:relative.db"), false); // drive-relative, no root separator
});

test("resolveAppPath trims a trailing separator of either kind off root before joining", () => {
  assert.equal(resolveAppPath("/srv/app/", "app.db"), "/srv/app/app.db");
  // A Windows-style root (uses backslashes) joins with "\\" and normalizes the relative segment's
  // separators to match, so the result is never mixed-separator ("C:\\srv\\app/app.db").
  assert.equal(resolveAppPath("C:\\srv\\app\\", "app.db"), "C:\\srv\\app\\app.db");
  assert.equal(resolveAppPath("C:\\srv\\app", "db/app.db"), "C:\\srv\\app\\db\\app.db");
  assert.equal(resolveAppPath("\\\\server\\share", "db/migrations"), "\\\\server\\share\\db\\migrations");
  // A drive-letter root that already uses forward slashes stays forward-slash (also non-mixed).
  assert.equal(resolveAppPath("C:/srv/app/", "app.db"), "C:/srv/app/app.db");
  // A forward-slash root joined with a backslash-containing relative segment normalizes the
  // segment to "/", so the result is never mixed-separator ("C:/srv/app/db\\migrations").
  assert.equal(resolveAppPath("C:/srv/app", "db\\migrations"), "C:/srv/app/db/migrations");
  assert.equal(resolveAppPath(".", "db\\migrations"), "./db/migrations");
});

test("parentDir keeps the trailing separator on a Windows drive root", () => {
  // A file directly under a drive root must yield the drive root itself, not the bare volume:
  // "C:" is a drive-relative reference, "C:\\" / "C:/" is the actual directory.
  assert.equal(parentDir("C:\\app.db"), "C:\\");
  assert.equal(parentDir("C:/app.db"), "C:/");
  // Nested paths and the no-parent cases keep working.
  assert.equal(parentDir("C:\\data\\app.db"), "C:\\data");
  assert.equal(parentDir("/var/data/app.db"), "/var/data");
  assert.equal(parentDir("app.db"), "");
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

test("MIGRATIONS_TABLE is the single canonical ledger name shared by application and listing", () => {
  // `applyMigrations` (datasource) writes this ledger and dataops' `migrations` op reads it; both
  // import this constant so the name can never drift between the two sites.
  assert.equal(MIGRATIONS_TABLE, "_urban_migrations");
});
