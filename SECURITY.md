# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue or pull request:
**[Report a vulnerability](https://github.com/omadityaxd/reelplane/security/advisories/new)**
(GitHub's private vulnerability reporting; only the maintainer sees it).

Include what you can of:

- the affected part (web app and API, `@reelplane/sdk-core`, `@reelplane/sdk-react`, the worker);
- the steps or a request that reproduces it, and what an attacker gains;
- the version or commit you tested.

Reelplane has one maintainer. You can expect an acknowledgement within 7 days and an assessment
within 14. Fixes for confirmed issues are released as soon as they are ready, with a GitHub
security advisory that credits you unless you prefer otherwise. Please give a reasonable time to
fix before disclosing publicly.

## Supported versions

| Component                                     | Supported                    |
| --------------------------------------------- | ---------------------------- |
| `main` branch (the deployed app and worker)   | ✅                           |
| `@reelplane/sdk-core`, `@reelplane/sdk-react` | the latest published version |

## Scope

In scope: anything in this repository, and the deployed demo where it runs this code. For
example: reading or changing another project's data, using a publishable (`rp_pk_`) key for more
than reading its own feed, bypassing upload size or rate limits, the worker processing a file in
a way that reads or runs anything beyond it, and webhook requests reaching private addresses.

Out of scope: denial of service by volume, findings that need a compromised account or machine,
missing hardening headers with no demonstrated impact, and third-party services (Supabase,
Vercel, GitHub) themselves, which have their own programs.

Please don't run automated scanners against the demo, access data that isn't yours, or upload
illegal content while testing; use a local setup (see the README's Quick start) instead.
