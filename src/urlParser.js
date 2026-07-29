const SLACK_PERMALINK_RE = /^https:\/\/[\w-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)/;
const LINEAR_ISSUE_RE = /^https:\/\/linear\.app\/([\w-]+)\/issue\/([A-Za-z]+-\d+)/;
const DEVIN_SESSION_RE = /^https:\/\/app\.devin\.ai\/sessions\/[\w-]+/;

export function parseLink(url) {
  const slackMatch = url.match(SLACK_PERMALINK_RE);
  if (slackMatch) {
    const [, channelId, digits] = slackMatch;
    const threadTs = `${digits.slice(0, -6)}.${digits.slice(-6)}`;
    return { source: 'slack', sourceRef: { channelId, threadTs, url } };
  }

  const linearMatch = url.match(LINEAR_ISSUE_RE);
  if (linearMatch) {
    const [, workspaceLabel, issueId] = linearMatch;
    return { source: 'linear', sourceRef: { workspaceLabel, issueId, url } };
  }

  if (DEVIN_SESSION_RE.test(url)) {
    return { source: 'devin', sourceRef: { url } };
  }

  return { source: 'url', sourceRef: { url } };
}
