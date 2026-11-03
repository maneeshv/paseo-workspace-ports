# Paseo registry submission

The maintainer will submit this plugin after publishing and checking the public source. Preparing these files does not create a registry listing or imply approval.

Use Paseo's [submission form](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml), which applies the label required for intake. The [publishing guide](https://paseo.sh/docs/plugins/publishing) and [registry review policy](https://github.com/getpaseo/plugins/blob/main/REVIEW.md) define the current process.

## Form values

| Field | Value |
| --- | --- |
| Title | Workspace Ports |
| Source | `https://github.com/maneeshv/paseo-workspace-ports` |
| Categories | Workspaces; Utils |
| Version | `0.1.0` |
| Description | Discover workspace apps and open them through a local SSH tunnel. |

The form currently asks for Source and Categories; the title is the issue title. Include an immutable Git commit in Source if a particular revision should be reviewed. Otherwise, the reviewer resolves `main` and records the approved commit. Do not claim a tag exists until one has been pushed.

## Listing material

- [Overview](../OVERVIEW.md): shipped listing text describing behavior, setup, data access, and limits.
- [Interface screenshot](../assets/screenshot.png): current panel with sample data; declared in the manifest.
- Public screenshot URL after push: `https://raw.githubusercontent.com/maneeshv/paseo-workspace-ports/main/assets/screenshot.png`.
- [README](../README.md): setup and development instructions.
- [Verification](verification.md): completed checks and remaining limits.
- [Security policy](../SECURITY.md) and [MIT license](../LICENSE).

Use the actual interface screenshot as registry media. The architecture diagram explains the design but is not a substitute for interface media.

## Before submitting

1. Confirm the public repository and screenshot URL are accessible and the intended commit is pushed.
2. Verify the committed manifest, runtime entries, imported modules, lockfile, overview, and media are present.
3. Run the locked dependency preparation, type checking, and tests from a clean checkout. Test the Git-installed plugin on an authorized development daemon and confirm it is running without errors.
4. Review the verification record and disclose any remaining limits. Installation needs Node.js 22.13 or newer and npm on the daemon's command path; dependency preparation is declared in the manifest.
5. Submit the form yourself. Respond to any review request with the corrected Git revision or requested information.

This is Git distribution; `private: true` prevents accidental npm publication and does not make the GitHub repository private. Registry approval pins a reviewed commit. Future Git updates need a manual submission for the desired revision, as described in the publishing guide.
