import { Octokit } from '@octokit/rest';

export const REVIEW_MARKER = '<!-- ai-code-reviewer -->';

export function createClient(token) {
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  return new Octokit({ auth: token });
}

export async function getPullRequest(octokit, { owner, repo, pull_number }) {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number });
  return data;
}

export async function getPullRequestFiles(octokit, { owner, repo, pull_number }) {
  return octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
}

/**
 * Files changed between two commits (used on "synchronize" so we only review
 * the newly pushed commits). Returns null if the comparison isn't possible,
 * e.g. after a force-push removed the old head.
 */
export async function getFilesChangedBetween(octokit, { owner, repo, base, head }) {
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
    });
    return data.files ?? [];
  } catch (err) {
    console.warn(`Could not compare ${base}...${head}: ${err.message}`);
    return null;
  }
}

export async function postReview(octokit, { owner, repo, pull_number, commit_id, body, comments }) {
  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number,
    commit_id,
    event: 'COMMENT',
    body: `${REVIEW_MARKER}\n${body}`,
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      body: c.body,
    })),
  });
}
