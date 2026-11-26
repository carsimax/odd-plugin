// The GitHub Release contract. The release workflow produces exactly these names; the updater consumes them.
export const RELEASE_REPO = "carsimax/odd-plugin";
export const BUNDLE_ASSET = "odd-claude.mjs";
export const CHECKSUMS_ASSET = "checksums.txt";

type Env = Record<string, string | undefined>;

/** `ODD_CLAUDE_REPO` overrides the repository (forks, tests). */
export const releaseRepo = (env: Env): string => env.ODD_CLAUDE_REPO || RELEASE_REPO;
export const releaseTag = (version: string): string => `v${version}`;
/** Tarball whose single top-level directory is `payloadTopDir(version)`. */
export const payloadAsset = (version: string): string => `odd-claude-payload-${version}.tar.gz`;
export const payloadTopDir = (version: string): string => `odd-claude-${version}`;
