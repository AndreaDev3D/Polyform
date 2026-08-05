# Trademarks

**Polyform is an independent project. It is not affiliated with, sponsored by, or
endorsed by any of the companies named below.**

Figma is a trademark of Figma, Inc. Where this project's documentation refers to
Figma, it does so **for identification and comparison only** — to describe what
Polyform does and does not do relative to a tool readers already know, and to
describe compatibility with `.fig` files that a Figma user exported themselves.
No claim to the mark is made or implied.

The same applies to any other product or company name that appears in this
repository: Electron, Chromium, Node.js, Rust, GitHub, Windows, macOS, Linux,
Apple, Debian, and the names of the open-source libraries listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) are the property of their
respective owners.

## What this project deliberately avoids

- **No mark in the name.** The product, the repository, the package and the file
  extension are Polyform's own (`Polyform`, `polyform`, `.poly`).
- **No borrowed branding.** No third-party logo, wordmark, icon set, typeface or
  brand colour is used or imitated anywhere in the app or its assets.
- **No implication of endorsement.** Nothing here describes Polyform as
  official, certified, powered by, or connected to another vendor.
- **No compatibility promise.** `.fig` import is best-effort and experimental,
  built from a publicly documented reading of a file format, and it reports what
  it could not translate rather than pretending to be faithful.

## `.fig` import

Polyform can read `.fig` files **you** exported from Figma, on your own machine,
offline. It does this by parsing the file, which is self-describing: it carries
the schema for its own contents.

Polyform does not decompile, modify, or connect to Figma's software or services;
it does not use Figma's APIs; and it sends nothing anywhere. If you are bound by
an agreement with a vendor about how you may use files their software produced,
that agreement is between you and them.

If you are a rights holder and something here concerns you, please open an issue
— we would rather fix wording than argue about it.
