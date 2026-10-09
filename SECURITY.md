# Security Policy

## Reporting a vulnerability

Report privately, not in a public issue. Open a
[GitHub security advisory](../../security/advisories/new) for this
repository; that keeps the report invisible until a fix is out.

Please include: the extension version, the browser and its version, what
the extension did, and what you expected instead. A minimal reproduction
— a text fragment, an `.eml`, a HAR — is worth more than a description,
**provided it contains no real data**. Use synthetic values: addresses
from RFC 5737 (`203.0.113.0/24`) and domains under `example.com`.

## What counts as a vulnerability here

The threat model of this extension is narrow and specific. These are
vulnerabilities:

- **anything that sends data out when the user did not ask for it.**
  A network request that is not one of the three listed in
  [PRIVACY.md](PRIVACY.md) is a defect regardless of where it points;
- **a bypass of client-data mode.** A path by which a value marked as
  client data reaches a service whose exposure is `public`;
- **a bypass of own/client ranges.** A value inside the configured
  ranges leaving for a public service without explicit confirmation;
- **code execution on a page** through parsed content: an indicator that
  becomes markup, a case note that becomes script;
- **storage of investigation data outside the browser profile.**

These are not vulnerabilities, by design:

- the extension opens a service you selected, and that service sees your
  query. That is what the tool is for, and the exposure tag on each tool
  says so in advance;
- "Pull text from link" fetches from your address. The interface warns
  about it next to the field;
- detection rules are drafts and are never deployed anywhere.

## Response

An acknowledgement within a few working days; a fix or a stated position
within thirty days. Credit in the changelog unless you prefer otherwise.
