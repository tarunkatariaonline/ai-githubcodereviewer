const SKIP_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /\.lock$/,
  /(^|\/)(dist|build|out|vendor|node_modules)\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.(png|jpe?g|gif|svg|ico|webp|pdf|zip|gz|woff2?|ttf|eot|mp4|mp3)$/i,
];

export const MAX_PATCH_CHARS = 20_000;

export function shouldSkipFile(file) {
  if (file.status === 'removed') return 'deleted';
  if (!file.patch) return 'no patch (binary or too large)';
  if (file.patch.length > MAX_PATCH_CHARS) return 'patch too large';
  if (SKIP_PATTERNS.some((re) => re.test(file.filename))) return 'ignored path';
  return null;
}

/**
 * Parses a unified diff patch from the GitHub API.
 *
 * Returns:
 *  - annotated:  the patch with new-file line numbers prefixed, for the model
 *  - commentable: new-file line numbers that appear in the diff (GitHub only
 *                 accepts inline comments on these)
 *  - added:      new-file line numbers that were added in this diff
 */
export function parsePatch(patch) {
  const commentable = new Set();
  const added = new Set();
  const out = [];
  let newLine = 0;

  for (const raw of patch.split('\n')) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      out.push(raw);
      continue;
    }
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"

    if (raw.startsWith('+')) {
      commentable.add(newLine);
      added.add(newLine);
      out.push(`${String(newLine).padStart(5)} + ${raw.slice(1)}`);
      newLine++;
    } else if (raw.startsWith('-')) {
      out.push(`      - ${raw.slice(1)}`);
    } else {
      commentable.add(newLine);
      out.push(`${String(newLine).padStart(5)}   ${raw.slice(1)}`);
      newLine++;
    }
  }

  return { annotated: out.join('\n'), commentable, added };
}
