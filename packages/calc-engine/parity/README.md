# Engine parity harness

Proves that a change to the engine (a move, a refactor, a dependency swap)
did not change a single number. It runs 46 calculator scenarios through
`computeProposal()` against a real `app_parameters` payload, in plain Node,
and compares two captures byte for byte — the merged parameter objects
included.

Written for the 2026-09-27 move of the engine out of the frontend's `src/lib`
and `src/data` (141/141 identical across the staging and production rows),
reused for the move into this package, and the bar for every change since.

```
# 1. the payload (COGS + margins — keep it out of git and chat)
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node packages/calc-engine/parity/fetch-params.mjs /tmp/params-staging.json

# 2. "before": the engine at the last release (or any older commit)
mkdir /tmp/before && tar -xzf solviva-calc-engine-1.0.0.tgz -C /tmp/before --strip-components=1
#   or: git archive <sha> packages/calc-engine | tar -x -C /tmp/before --strip-components=2
node packages/calc-engine/parity/capture.mjs /tmp/before /tmp/params-staging.json /tmp/before.json

# 3. "after": the working tree
node packages/calc-engine/parity/capture.mjs packages/calc-engine /tmp/params-staging.json /tmp/after.json

# 4. compare — exit 0 means identical
node packages/calc-engine/parity/compare.mjs /tmp/before.json /tmp/after.json
```

Run it against the production row as well as staging; the two rows differ
(devices, margins) and have caught different things.

A deliberate formula change will fail this comparison. That is the point:
make the change, run the harness, and read the diff to confirm it changed
exactly the scenarios and fields you meant it to.
