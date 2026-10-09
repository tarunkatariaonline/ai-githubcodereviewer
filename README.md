# AI Code Reviewer

A GitHub Action that reviews pull requests with Google Gemini. It reads the diff of every PR and posts inline comments on lines that have real problems: bugs, security issues, crashes or clearly wrong logic. It doesn't comment on style.

```
PR opened / new commits pushed
        │
        ▼
GitHub Actions runs the reviewer
        │
        ├─ 1. Fetch the PR's changed files and diffs   (GitHub API)
        ├─ 2. Skip noise: lockfiles, build output, binaries
        ├─ 3. Number the diff lines; work out which lines can take comments
        ├─ 4. Send each file to Gemini, get JSON comments back
        ├─ 5. Drop comments on lines that aren't in the diff
        └─ 6. Post one review with all inline comments   (GitHub API)
```

A finished review looks like this:

> **github-actions[bot]** reviewed
> 🤖 **AI review** found 2 issue(s) in 1 file(s) (critical: 2, warnings: 0, suggestions: 0).
>
> `api/users.js` line 11: 🔴 **Critical**: SQL injection: `id` is put straight into the query string. Use a parameterized query (`$1`).

## Setup

### 1. Add your Gemini API key

In the repo you want reviewed, open **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | your key from [Google AI Studio](https://aistudio.google.com/apikey) |

You don't need to create a GitHub token. GitHub provides `GITHUB_TOKEN` to every run.

### 2. Add the workflow

Create `.github/workflows/ai-review.yml` in that repo:

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: <your-github-user>/githubcodereviewer@main
        with:
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
```

This repo reviews its own PRs with [.github/workflows/ai-review.yml](.github/workflows/ai-review.yml). That workflow uses `uses: ./` together with `actions/checkout`.

### 3. Open a pull request

The review appears on the PR within a minute or two. To watch it run, open the **Actions** tab.

## Configuration

These are inputs to the action, set under `with:`:

| Input | Default | Description |
|---|---|---|
| `gemini-api-key` | (required) | Gemini API key |
| `github-token` | `${{ github.token }}` | Token used to read the PR and post the review |
| `model` | `gemini-3.5-flash-lite` | Gemini model to use |
| `max-files` | `30` | Maximum number of files reviewed per run |
| `max-comments` | `20` | Maximum number of inline comments per review |

## When it runs

| Event | What gets reviewed |
|---|---|
| PR opened, reopened or marked ready for review | Every changed file in the PR |
| New commits pushed (`synchronize`) | Only lines added by the new push, so nothing is reviewed twice. If the push can't be compared (for example after a force-push), the whole PR is reviewed again. |
| Draft PR | Skipped |

After a push, if nothing new is found, the reviewer posts nothing. That avoids a "no issues" review on every commit.

### Files that are skipped

- Deleted files and binary files
- Patches over 20,000 characters
- Lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `*.lock`)
- `dist/`, `build/`, `out/`, `vendor/`, `node_modules/`
- Minified files, source maps, images, fonts and media

To change these rules, edit `SKIP_PATTERNS` in [src/diff.js](src/diff.js).

## Running locally

Use this to tune the prompt or test on a real PR before installing the workflow.

```bash
npm install

# .env
GEMINI_API_KEY=your-gemini-key

# Print the review without posting anything
GITHUB_TOKEN=$(gh auth token) npm run review -- --repo owner/name --pr 123 --dry-run

# Post the review for real
GITHUB_TOKEN=$(gh auth token) npm run review -- --repo owner/name --pr 123
```

`gh auth token` needs the [GitHub CLI](https://cli.github.com/). Any personal access token with access to that repo also works.

## How it works

| Step | Function | Package | API |
|---|---|---|---|
| Identify the PR | `resolveContext` | Node `fs` | Reads the event file at `GITHUB_EVENT_PATH` |
| PR details | `getPullRequest` | `@octokit/rest` | `GET /repos/{owner}/{repo}/pulls/{n}` |
| Changed files | `getPullRequestFiles` | `@octokit/rest` | `GET /repos/{owner}/{repo}/pulls/{n}/files` |
| New commits only | `getFilesChangedBetween` | `@octokit/rest` | `GET /repos/{owner}/{repo}/compare/{before}...{after}` |
| Filter and number lines | `shouldSkipFile`, `parsePatch` | none | none |
| AI review | `reviewFile` | `@google/genai` | Gemini `generateContent` with a JSON schema |
| Post comments | `postReview` | `@octokit/rest` | `POST /repos/{owner}/{repo}/pulls/{n}/reviews` |

A few details:

- **Line numbers:** `parsePatch` puts each line's number in the new file in front of the line before the diff goes to Gemini. Gemini can then point at exact lines. Any comment on a line outside the diff is dropped, because GitHub would reject the whole review.
- **Output format:** Gemini must answer with JSON in the form `{ comments: [{ line, severity, comment }] }`, so the reviewer never has to parse free text.
- **One review:** all comments go into a single review with `event: "COMMENT"`. That's one notification, and the bot never approves or blocks a PR.
- **Concurrency:** files are reviewed 4 at a time. If one file fails, the others are still reviewed.

## Project structure

```
src/
  index.js      Main flow: read event → fetch → filter → review → validate → post
  github.js     GitHub API calls (Octokit)
  diff.js       File filtering and diff parsing
  reviewer.js   Gemini prompt, response schema and API call
action.yml      Packages the reviewer as a reusable GitHub Action
.github/workflows/ai-review.yml   Runs the reviewer on this repo's own PRs
```

## Limitations

- **PRs from forks:** GitHub doesn't give repository secrets to workflows triggered by forks, so the review fails for fork PRs. Don't switch to `pull_request_target` to work around this; that runs untrusted code with access to your secrets.
- **The model only sees the diff:** it doesn't see the rest of the codebase, so it can miss problems that depend on code elsewhere.
- **Prompt injection:** PR content is untrusted. The prompt tells the model to ignore instructions inside the code, and the worst a bad comment can do is add a misleading review comment. The token can't merge or push.
- **Cost:** you're billed for one Gemini request per reviewed file.
