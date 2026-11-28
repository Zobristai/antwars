# Fill historical Free-for-all place records

After upgrading the rating writer, run the fill from a source checkout at the deployed revision. The runtime image contains neither the command nor its fill module. From the checkout root, use Node 24 and install the dependencies with `npm ci`.

For production, use a compute host whose attached service identity can read the target Firestore data and write the rating rows. The client authenticates as that identity; a local cloud CLI login alone does not authenticate it. Set `GCLOUD_PROJECT` and `ANTWAR_STORE_NAMESPACE` to the intended store and leave `FIRESTORE_EMULATOR_HOST` unset. Only for a local rehearsal, set `FIRESTORE_EMULATOR_HOST` to the loopback emulator instead.

Start with a read-only preview:

```sh
node --import ./src/ts-resolve.mjs scripts/fill-ffa-records.ts
```

Check the namespace, number of rated matches, four finishes per match, and each model’s four counts and newest five matches. For the original 11 matches expect 44 finishes; the leading model had 4 firsts, 1 second, 1 third and no fourths. The preview reads the immutable rating markers, orders them by their Firestore creation time (the commit that rated the match), and reconciles the results against current rating rows. It does not write. Match ids in this report are lobby ids; the public leaderboard resolves replay ids on read.

Only after checking the preview, an authorized operator can repeat the command with `--apply`. It recomputes and checks before writing, updates only the two record fields in one transaction, and skips already matching records. Preview again: `rowsToFill` must be zero. Missing history, ambiguous per-model order, count or record disagreement abort the entire fill. If a match was rated during the scan, take a fresh preview; do not override a persistent mismatch.
