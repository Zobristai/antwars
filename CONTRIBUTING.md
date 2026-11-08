# Contributing

## Pull requests

Every change reaches `main` through a pull request:

1. Work on a branch of your own, not on `main`.
2. Open a pull request from that branch into `main`, saying what it changes
   and why.
3. Maintainers review the pull request's current head twice: once for
   security and once for correctness and fit with the project. A new push
   changes the head, so it is reviewed again.
4. A maintainer squash-merges the pull request once both reviews approve it
   and its checks pass, or asks for changes, or closes it with the reason.

### Required checks

A pull request into `main` must pass three checks:

- `identifiers`, the job of the `gitleaks` workflow (see
  [Private identifier and secret check](#private-identifier-and-secret-check));
- `history-isolation`, which refuses a history with any root but the
  repository's initial commit, or a commit whose author, committer or message
  holds a private identifier;
- `checks`, the job of the `antwar ci` workflow.

To run them locally: the pre-commit hook (below) scans each commit's staged
files with gitleaks' default rules. It runs the private identifier scan only
when you hold the private identifier list; without it that scan is skipped with
a notice, and the `identifiers` check runs it in CI over the whole pull request.
`history-isolation` needs the private identifier list, so it runs in CI. The
`antwar ci` checks need Node.js 24, Java 21 (for the Firestore emulator) and
firebase-tools 15.35.0 (`npm install -g firebase-tools@15.35.0`); then, from the
repository root:

```sh
npm ci
npx playwright-core install --with-deps webkit
npx tsc --noEmit
npm run lint
node scripts/ci/test-set-diff.ts
npm test
```

`npm test` starts the Firestore emulator and runs the essential test suite.

Keep each pull request small enough to read in full. A large change is asked
to be split into smaller pull requests, each one complete on its own.

To report a security vulnerability, do not open a pull request or issue; follow
[SECURITY.md](SECURITY.md).

## Private identifier and secret check

Some identifiers belong to the people and infrastructure that run this project
and must never be committed: a private hosting id, a cloud project id and its
service-account addresses, a cloud project number, and owner email addresses.
They are not in this repository in any form, not even as patterns. The checks
read them at run time from a list kept outside the repository, and
`.githooks/identifier-config` turns each listed identifier into a rule that
matches it case-insensitively as a literal substring. Ordinary secrets, such as
API keys and tokens, are found by gitleaks' default rules, configured in
`.gitleaks-defaults.toml`.

The two rule sets are scanned separately. The identifier rules never extend
another config, because extending gitleaks' defaults also brings in their path
allowlist (lockfiles, images, fonts, `node_modules` and more), which would stop
the identifier rules from checking those files. `.gitleaks-defaults.toml` turns
on the default rules and allowlists only a few known synthetic test keys, each
by its exact file and line and only for the rule that matched it.

Two checks run both scans and refuse a change that fails either. Neither shows
the matched value:

- a pre-commit hook, which scans the staged version of every added or changed
  file before the commit is made;
- the `gitleaks` GitHub Actions workflow (its job is `identifiers`), which
  repeats the check on every pull request into `main` and every push to
  `main`, so a commit that skipped the hook still fails there. It shows each
  finding as an error annotation on the run (the first nine, then a count) and
  lists every finding in the job summary.

A path, a commit's author, email or message, or the rest of a matched line
could itself hold an identifier, so both checks show only each finding's rule,
line, commit SHA (CI only) and the sha256 of the file's path. To find the file,
list the paths at that commit (or, for the hook, the staged paths with
`git diff --cached --name-only -z` in place of `git ls-tree`) with their
hashes:

```sh
git ls-tree -r --name-only -z <commit> |
  while IFS= read -r -d '' p; do printf '%s %s\n' "$(printf '%s' "$p" | sha256sum | cut -c1-64)" "$p"; done |
  grep '^<path-sha256> '
```

Neither check accepts an exception: `gitleaks:allow` comments and
`.gitleaksignore` entries do not suppress these findings. If a check refuses
your change, remove the value and read it from configuration instead.

### The identifier list

The list is UTF-8 text with LF line endings and one identifier per line, written
as the literal identifier. Every line is read, including a last line without a
newline, and blank lines are skipped. Matching ignores case. A list with no
identifiers (empty or only whitespace), or with a CR or another control
character, is refused, and the error names only the line number. A TAB inside
a line is accepted and is part of that identifier.

- The pre-commit hook reads it from `.git/antwars-identifiers`, which Git never
  tracks. Maintainers who hold the list put it there. Without that file, the
  hook prints a notice and skips the identifier scan; the defaults scan still
  runs, and CI still runs both. The list only ever reaches trusted code, never
  the working tree, which any branch you check out can change: the hook reads
  the list only when it runs as the copy installed in the Git directory
  (below), and it builds the rules with the `.githooks/identifier-config` of
  `origin/main`, read as a git object. Run `git fetch origin main` to pick up
  a change to that generator.
- The workflow reads it from the `ANTWARS_IDENTIFIERS` Actions secret. A missing
  or empty secret fails the job. Pull requests are checked under
  `pull_request_target`, so the secret only ever reaches the base branch's
  code: the workflow, the gitleaks install, `.github/scripts/identifiers-scan.sh`,
  `.githooks/identifier-config` and `.gitleaks-defaults.toml` all come from
  `main`. The pull request is fetched and read only as git objects, never
  checked out, run or loaded as config. When a pull request changes one of
  those files, the job prints a notice naming it, and the change takes effect
  only once it is on `main`.

### Changing the default rules

The default-rules config is fixed. The hook scans with the approved version of
`.gitleaks-defaults.toml`, named by the `defaults_baseline=` line in
`.githooks/pre-commit`, never with your working copy or your change's own copy,
and refuses a change whose `.gitleaks-defaults.toml` differs from it. The
workflow scans with `main`'s copy and refuses a change whose
`.gitleaks-defaults.toml` does not match its own `defaults_baseline=` line.

Changing the config is a maintainers' decision. It lands as one reviewed change
that updates the config and its line together:

1. Edit `.gitleaks-defaults.toml` and stage it with
   `git add .gitleaks-defaults.toml`.
2. Run `git rev-parse :.gitleaks-defaults.toml` and put the id it prints on the
   `defaults_baseline=` line in `.githooks/pre-commit`.
3. Commit the config and the hook in the same change.

### Installing the hook

1. Make sure `python3` is installed; the hook uses it to report findings.
   Install gitleaks 8.30.1, the version CI uses, from
   <https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1> (or your package
   manager, if it provides that version), and check that `gitleaks version`
   prints `8.30.1`.
2. From the repository root, install `main`'s hook in the Git directory,
   where no checkout can change it, and make sure Git does not run hooks from
   the working tree:

   ```sh
   git fetch origin main
   hooks="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
   mkdir -p "$hooks"
   git cat-file blob origin/main:.githooks/pre-commit > "$hooks/pre-commit"
   chmod +x "$hooks/pre-commit"
   git config --unset core.hooksPath || true
   ```

   Run the same commands again after the hook changes on `main`.

The hook refuses every commit while gitleaks is not installed, rather than
letting it through unchecked. With `.git/antwars-identifiers` present, it also
refuses every commit when it runs from anywhere but the Git directory's hooks
folder (for example through `core.hooksPath .githooks`), or when `origin/main`
has no `.githooks/identifier-config`.
