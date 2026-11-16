# AIT development

At the start of AIT development on a machine that also runs an installed instance, read [Developing alongside an installed AIT](docs/developing-alongside-installed-ait.md). The source checkout and the checkout serving live sessions may be different. Recheck their paths only if service ownership or the installation changes.

## Dependency maintenance

Before adding a dependency override, compatibility adapter or maintained fork for
a dependency or security issue, check the current supported AT Protocol packages
and whether a coherent upstream stack upgrade resolves it. Prefer that upgrade
when it does. Verify the actual consumers and any persisted-data migration in
isolated worktrees; package resolution and a clean audit alone do not prove
compatibility. Identify concrete upstream blockers before proposing custom fixes.
