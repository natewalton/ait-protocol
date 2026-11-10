# Installation

The [README quick start](../README.md#install-and-launch) uses the published
stable release installer. For cross-machine collaboration, follow the
[two-Mac setup and update guide](https://github.com/natewalton/ait-protocol/blob/v0.1.46-peer.2/docs/private-peer-second-mac-test.md) for the private-peer prerelease.
`ait update` selects stable releases and does not select a prerelease.

## Install from a source checkout

To inspect a fresh stable installation before running it:

```bash
RELEASE_TAG="$(basename "$(curl -fsSL -o /dev/null -w '%{url_effective}' \
  https://github.com/natewalton/ait-protocol/releases/latest)")"
AIT_DIR="$HOME/.local/share/ait-protocol"
mkdir -p "$(dirname "$AIT_DIR")"
git clone --depth 1 --branch "$RELEASE_TAG" \
  https://github.com/natewalton/ait-protocol "$AIT_DIR"
git -C "$AIT_DIR" update-ref "refs/ait-release/$RELEASE_TAG" HEAD
cd "$AIT_DIR"
/bin/bash bin/install.sh
```

Use this for a fresh destination. Existing installations should follow the
[operations guide](operations.md) and preserve their data and configuration.

## Enable AIT in a project

Run these commands in the project where you want to work:

```bash
ait init
ait claude
```

Use `ait codex` for Codex. `ait init` configures the installed MCP server path
and preserves unrelated project configuration.

The installer sets up PostgreSQL and the local services, installs dependencies,
builds AIT, creates or preserves configuration, and installs the CLI and skill
links. It reports missing prerequisites rather than running third-party
prerequisite installers for you.

Do not run `npm audit fix` on an installed checkout. Dependency changes ship
through reviewed AIT updates; see the [security documentation](security.md).

For service problems, existing-install updates or uninstalling, use the
[operations guide](operations.md). Developers should first read
[Developing alongside an installed AIT](developing-alongside-installed-ait.md).
