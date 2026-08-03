// Parsing a git remote URL into the pieces a "open a PR" flow needs.
//
// Every form below is one git actually writes into `.git/config` depending on
// how the repo was cloned, and they are not interchangeable: the SCP-like form
// (`git@host:owner/repo.git`) is not a URL at all and `new URL()` throws on it,
// while `ssh://` *is* a URL but carries a userinfo component that must not end
// up in the owner. Getting this wrong doesn't error — it silently builds a
// compare link to a repository that doesn't exist — which is why it's pure and
// tested rather than a regex inline in the IPC handler.

export type RemoteProvider = 'github' | 'gitlab' | 'bitbucket' | 'other'

export interface RemoteInfo {
  host: string
  owner: string
  repo: string
  provider: RemoteProvider
}

function providerOf(host: string): RemoteProvider {
  const h = host.toLowerCase()
  if (h === 'github.com' || h.endsWith('.github.com')) return 'github'
  if (h === 'gitlab.com' || h.startsWith('gitlab.')) return 'gitlab'
  if (h === 'bitbucket.org') return 'bitbucket'
  return 'other'
}

export function parseRemoteUrl(raw: string | null | undefined): RemoteInfo | null {
  const url = (raw ?? '').trim()
  if (!url) return null

  let host: string
  let path: string

  // SCP-like: [user@]host:path — no scheme, and the colon is a separator, not a
  // port. Guarded against matching "https://host:443/..." by requiring no "//".
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url)
  if (scp && !url.includes('://')) {
    host = scp[1]
    path = scp[2]
  } else {
    try {
      const u = new URL(url)
      host = u.hostname // hostname, not host: drops the port and any userinfo
      path = u.pathname
    } catch {
      return null
    }
  }

  const parts = path.replace(/^\/+/, '').replace(/\.git$/i, '').split('/').filter(Boolean)
  if (parts.length < 2) return null
  // A nested group path (GitLab subgroups: owner/group/sub/repo) keeps the repo
  // as the last segment and everything before it as the owner, which is exactly
  // what the provider's own URLs use.
  const repo = parts[parts.length - 1]
  const owner = parts.slice(0, -1).join('/')
  if (!owner || !repo) return null

  return { host, owner, repo, provider: providerOf(host) }
}

/** Canonical browser URL for the repository itself. */
export function repoUrl(info: RemoteInfo): string {
  return `https://${info.host}/${info.owner}/${info.repo}`
}

/**
 * The "open a pull request" page for `head` against `base`.
 *
 * This is the fallback path when the `gh` CLI isn't installed or isn't
 * authenticated: the branch is already pushed at that point, so handing the user
 * a prefilled compare page still completes the loop — it just costs a click.
 * Providers disagree on the path, and an unknown host gets the repo root rather
 * than a guessed URL that 404s.
 */
export function compareUrl(info: RemoteInfo, base: string, head: string): string {
  const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  switch (info.provider) {
    case 'github':
      return `${repoUrl(info)}/compare/${range}?expand=1`
    case 'gitlab':
      return `${repoUrl(info)}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(head)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(base)}`
    case 'bitbucket':
      return `${repoUrl(info)}/pull-requests/new?source=${encodeURIComponent(head)}&dest=${encodeURIComponent(base)}`
    default:
      return repoUrl(info)
  }
}

/** Only GitHub has a `gh pr create` to try; everything else goes to the web. */
export function supportsCli(info: RemoteInfo): boolean {
  return info.provider === 'github'
}
