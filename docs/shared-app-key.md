# Shared application key — federation contract

Owner decision (2026-10-31): the Entire workbench repo is the canonical
home of the shared application key declaration. This document is the
contract CivicScope mirrors so a single deployment value federates
into the product unchanged.

Scope: the **Census application key** only. The shared Meta key is a
spending credential; it lives only in the server-side proxy secret and
must never be declared, mirrored, or shipped to a client. Nothing in
this contract applies to it.

## Why a shared key may be client-visible

A Census application key is a per-application credential: the Census
Bureau issues it to an application, not to a person, so the Census API
can attribute and rate-limit that application's traffic. It identifies
the app. It carries no user data, unlocks no non-public data (every
figure it fetches is published), and is designed to be presented by
client software. A visitor's personal Census key is the opposite kind
of object — their credential — and stays in their browser only.

## The slot

| Piece | Value |
|---|---|
| Pages environment variable | `CENSUS_APP_KEY` |
| Client-visible global slot | `__CIVICSCOPE_SHARED_APP_KEYS__`, an object with a `CENSUS_APP_KEY` field |
| Canonical module | `src/core/config/shared-app-key.ts` |
| Resolution entry point | `resolveCensusKeyForApp` |

Supply path: the deployment sets the Pages environment variable; at
serve/build time the host page exposes the value in the global slot;
the module is the only reader. The value never appears in source,
commits, issues, pull requests, or chat.

## Module shape to mirror

CivicScope mirrors the module at the same path, with the same exports:

- `CENSUS_APP_KEY_ENV_VAR` — the string `CENSUS_APP_KEY`.
- `SHARED_APP_KEYS_GLOBAL` — the global slot name above.
- `SharedAppKeyEnv` — `{ CENSUS_APP_KEY?: unknown }`.
- `CensusKeySource` — `'visitor' | 'shared' | 'none'`.
- `ResolvedCensusKey` — `{ key: string | null, source: CensusKeySource }`.
- `normalizeSharedAppKeyValue(raw)` — a deployment value survives only
  as a clean token: non-strings, empty or whitespace-only strings, and
  values with interior whitespace all normalize to absent.
- `readSharedCensusAppKey(env?)` — reads an injected env, or the
  global slot when no env is passed.
- `resolveCensusKey({ visitorKey, sharedAppKey })` — the pure
  precedence rule.
- `resolveCensusKeyForApp({ visitorKey, env? })` — the one call a
  Census-key consumer makes.

## Precedence

1. **Visitor key** — the visitor's own stored personal Census key,
   already normalized by the app's key module. When present, it is
   always used.
2. **Shared app key** — the deployment-supplied value, when the
   visitor has no personal key.
3. **None** — no key is sent. This reproduces the pre-existing
   behaviour exactly: keyless surfaces work and Census-key plugins
   report their needs-key state. The shared key is an addition, never
   a new gate.

Resolution happens at read time, so storing or clearing a personal
key takes effect on the next resolution with no other wiring.

## Privacy wording

CivicScope's privacy text carries this sentence verbatim:

> The app includes a built-in project Census key so housing data loads on your first visit; a Census key you add yourself stays only in your browser and is used instead of the project key.

## Rotation

Rotation is a deployment act, never a code change:

1. Request a replacement application key from the Census Bureau's key
   signup page, under the project account.
2. Set `CENSUS_APP_KEY` to the new value in the Pages environment
   (production and preview).
3. Redeploy and run the deploy checklist below, including the cold
   profile check.
4. Retire the old key with the Census Bureau once the new value is
   verified live.
5. Record the rotation date in the project tracker. The value itself
   is recorded nowhere.

## Deploy checklist

- [ ] `CENSUS_APP_KEY` is set in the Pages environment for the target
      deployment (production and preview, as applicable).
- [ ] Cold browser profile (no stored personal key, storage cleared):
      ACS housing figures load on first visit with no setup step.
- [ ] With a personal Census key stored: resolution uses the personal
      key, not the shared one; clearing it falls back to the shared
      key.
- [ ] With the environment value removed in a preview deploy:
      behaviour returns to the needs-key baseline, nothing errors.
- [ ] The value appears in no commit, issue, pull request, screenshot,
      or message produced during the deploy.

## Federation steps for the CivicScope lane

1. Mirror `src/core/config/shared-app-key.ts` from this repo at the
   same path, byte-identical in exports and semantics.
2. In CivicScope's Census key module, resolve through
   `resolveCensusKeyForApp`, passing the stored personal key as
   `visitorKey`; use the resolved key for Census requests and keep the
   existing re-validation event semantics for personal-key changes.
3. Add the privacy sentence above to the privacy text, verbatim.
4. Mirror the shared-app-key tests and keep them hermetic — fake
   placeholder values only, assembled from short segments.
5. Set `CENSUS_APP_KEY` on the CivicScope Pages project (the same
   value as the workbench deployment, if both are deployed) and run
   the deploy checklist.
