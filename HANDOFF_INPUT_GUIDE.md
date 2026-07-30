# Handoff Input Guide

Use BOTH source baselines and handoff files as required inputs for backend update cycles.

## Required input artifacts

1. Source baseline (code + schema baseline)

- Preferred: versioned source folder or branch/commit reference
- Include matching migration baseline when schema changes are involved

2. Handoff document set (change intent)

- Primary: `HANDOFF.md`
- Optional: migration notes, release notes, API change notes

## Required sections in each handoff

1. Scope

- Endpoint/logic changes
- Backward compatibility constraints

2. Files touched

- API/server files
- SQL migrations

3. Contract changes

- Request/response changes
- Required frontend updates

4. Data changes

- New tables/columns
- RLS/policy changes
- Migration and rollback notes

5. Validation

- Health check and API test commands
- Expected response samples

6. Deployment

- Required env vars
- Deployment and post-deploy checks

## Update workflow

1. Lock the backend source baseline (folder or commit SHA).
2. Read latest handoff first.
3. Compare requested changes against baseline and current backend.
4. Implement server and migration changes.
5. Validate locally.
6. Record final outcomes in `HANDOFF.md`.

## Rule for future sessions

No backend change is considered done without:

- a declared source baseline, and
- an updated handoff file.
