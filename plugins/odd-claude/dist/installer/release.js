// The GitHub Release contract. The release workflow produces exactly these names; the updater consumes them.
export const RELEASE_REPO = "carsimax/odd-plugin";
export const BUNDLE_ASSET = "odd-claude.mjs";
export const CHECKSUMS_ASSET = "checksums.txt";
/** `ODD_CLAUDE_REPO` overrides the repository (forks, tests). */
export const releaseRepo = (env) => env.ODD_CLAUDE_REPO || RELEASE_REPO;
export const releaseTag = (version) => `v${version}`;
/** Tarball whose single top-level directory is `payloadTopDir(version)`. */
export const payloadAsset = (version) => `odd-claude-payload-${version}.tar.gz`;
export const payloadTopDir = (version) => `odd-claude-${version}`;
