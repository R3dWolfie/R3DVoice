-- Backfill: canonicalize existing User.email to lowercase so lookups become
-- case-insensitive (matches the new register/login/reset canonicalization and
-- the handleLower convention).
--
-- Collision-safe: "email" is UNIQUE, so a blind `UPDATE ... SET email = LOWER(email)`
-- would crash whenever two rows collide once lowercased. A row is only lowered
-- when BOTH hold:
--   (a) the target lowercase address isn't already taken verbatim by another
--       row (guards "FOO@x" (old) vs already-lowercase "foo@x" (new)), and
--   (b) this row is the OLDEST mixed-case row mapping to that address
--       (createdAt, id tie-break) — so among two mixed-case siblings the oldest
--       wins and the newer one keeps its verbatim email.
-- Any row skipped by these guards keeps its original email (never crashes); such
-- collisions are expected to be rare and leave the OLDEST account reachable at
-- the canonical lowercase address.
UPDATE "User"
SET "email" = LOWER("email")
WHERE "email" <> LOWER("email")
  AND NOT EXISTS (
    SELECT 1 FROM "User" AS o
    WHERE o."id" <> "User"."id"
      AND o."email" = LOWER("User"."email")
  )
  AND NOT EXISTS (
    SELECT 1 FROM "User" AS s
    WHERE s."id" <> "User"."id"
      AND s."email" <> LOWER(s."email")
      AND LOWER(s."email") = LOWER("User"."email")
      AND (
        s."createdAt" < "User"."createdAt"
        OR (s."createdAt" = "User"."createdAt" AND s."id" < "User"."id")
      )
  );
