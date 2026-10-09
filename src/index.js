import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parsePatch, shouldSkipFile } from './diff.js';
import {
  createClient,
  getFilesChangedBetween,
  getPullRequest,
  getPullRequestFiles,
  postReview,
} from './github.js';
import { reviewFile } from './reviewer.js';

const MAX_FILES = Number(process.env.MAX_FILES || 30);
const MAX_COMMENTS = Number(process.env.MAX_COMMENTS || 20);
const CONCURRENCY = 4;

const SEVERITY_ORDER = { critical: 0, warning: 1, suggestion: 2 };
const SEVERITY_LABEL = {
  critical: '🔴 **Critical**',
  warning: '🟠 **Warning**',
  suggestion: '🔵 **Suggestion**',
};

/**
 * Works out which PR to review. In GitHub Actions this comes from the event
 * payload; locally it comes from --repo owner/name --pr 123.
 */
function resolveContext() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      pr: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  const dryRun = values['dry-run'] || process.env.DRY_RUN === 'true';

  if (values.repo && values.pr) {
    const [owner, repo] = values.repo.split('/');
    return { owner, repo, pull_number: Number(values.pr), action: 'manual', dryRun };
  }

  if (process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (!event.pull_request) throw new Error('This workflow must be triggered by a pull_request event');
    return {
      owner: event.repository.owner.login,
      repo: event.repository.name,
      pull_number: event.pull_request.number,
      action: event.action,
      before: event.before,
      after: event.after,
      dryRun,
    };
  }

  throw new Error('Usage: node src/index.js --repo owner/name --pr 123 [--dry-run]');
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const ctx = resolveContext();
  const { owner, repo, pull_number } = ctx;
  const octokit = createClient(process.env.GITHUB_TOKEN);

  const pr = await getPullRequest(octokit, ctx);
  if (pr.draft) {
    console.log('PR is a draft, skipping review.');
    return;
  }
  console.log(`Reviewing ${owner}/${repo}#${pull_number}: ${pr.title}`);

  const prFiles = await getPullRequestFiles(octokit, ctx);

  // On a new push, only review lines added by the new commits.
  let newlyAddedLines = null; // Map<filename, Set<line>>
  if (ctx.action === 'synchronize' && ctx.before && ctx.after) {
    const changed = await getFilesChangedBetween(octokit, {
      owner,
      repo,
      base: ctx.before,
      head: ctx.after,
    });
    if (changed) {
      newlyAddedLines = new Map(
        changed.filter((f) => f.patch).map((f) => [f.filename, parsePatch(f.patch).added]),
      );
    }
  }

  const toReview = [];
  for (const file of prFiles) {
    const skipReason = shouldSkipFile(file);
    if (skipReason) {
      console.log(`  skip ${file.filename} (${skipReason})`);
      continue;
    }
    const parsed = parsePatch(file.patch);
    let allowedLines = parsed.commentable;
    if (newlyAddedLines) {
      const added = newlyAddedLines.get(file.filename);
      if (!added) continue; // not touched by the latest push
      allowedLines = new Set([...added].filter((l) => parsed.commentable.has(l)));
      if (allowedLines.size === 0) continue;
    }
    toReview.push({ path: file.filename, annotatedPatch: parsed.annotated, allowedLines });
  }

  if (toReview.length > MAX_FILES) {
    console.log(`  ${toReview.length} files to review, limiting to ${MAX_FILES}`);
    toReview.length = MAX_FILES;
  }
  console.log(`Reviewing ${toReview.length} file(s)...`);

  const perFile = await mapWithConcurrency(toReview, CONCURRENCY, async (file) => {
    try {
      const raw = await reviewFile({
        path: file.path,
        annotatedPatch: file.annotatedPatch,
        prTitle: pr.title,
        prBody: pr.body,
      });
      // The model can invent line numbers; GitHub rejects comments outside the diff.
      return raw
        .filter((c) => Number.isInteger(c.line) && file.allowedLines.has(c.line) && c.comment?.trim())
        .map((c) => ({ ...c, path: file.path }));
    } catch (err) {
      console.warn(`  review failed for ${file.path}: ${err.message}`);
      return [];
    }
  });

  const comments = perFile
    .flat()
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3))
    .slice(0, MAX_COMMENTS)
    .map((c) => ({
      path: c.path,
      line: c.line,
      body: `${SEVERITY_LABEL[c.severity] ?? '**Note**'}\n\n${c.comment.trim()}`,
    }));

  const counts = perFile.flat().reduce((acc, c) => {
    acc[c.severity] = (acc[c.severity] ?? 0) + 1;
    return acc;
  }, {});
  const summary = comments.length
    ? `🤖 **AI review** found ${comments.length} issue(s) in ${toReview.length} file(s)` +
      ` (critical: ${counts.critical ?? 0}, warnings: ${counts.warning ?? 0}, suggestions: ${counts.suggestion ?? 0}).`
    : `🤖 **AI review**: no issues found in ${toReview.length} file(s).`;

  if (ctx.dryRun) {
    console.log(`\n--- DRY RUN ---\n${summary}\n`);
    for (const c of comments) console.log(`${c.path}:${c.line}\n${c.body}\n`);
    return;
  }

  // Don't post an empty review on every push; only on the first review.
  if (comments.length === 0 && ctx.action === 'synchronize') {
    console.log('No new issues, not posting a review.');
    return;
  }

  await postReview(octokit, {
    owner,
    repo,
    pull_number,
    commit_id: pr.head.sha,
    body: summary,
    comments,
  });
  console.log(`Posted review with ${comments.length} comment(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
