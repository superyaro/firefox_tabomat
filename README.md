# Tabomat — URL-to-Window Router for Firefox

[![CI](https://github.com/superyaro/firefox_tabomat/actions/workflows/ci.yml/badge.svg)](https://github.com/superyaro/firefox_tabomat/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Firefox normally opens external links in the last active window. That gets
messy when you switch between projects or topics during the day.

URL-to-Window Router keeps related links together: when a new HTTP(S) tab opens,
it looks for an existing Firefox window with a matching project, repository,
issue group, or domain and moves the tab there.

By default, the route is the simple registrable domain:

- `https://www.heise.de/newsticker` routes like `heise.de`.
- `https://m.heise.de/...` routes like `heise.de`.
- `https://news.ycombinator.com/...` routes like `ycombinator.com`.

The extension only moves tabs. It does not redirect URLs, change URLs, use
`webRequest`, or reload pages.

## Settings

Open the extension preferences from `about:addons` to configure:

- routing enabled/disabled,
- fallback routing by domain,
- whether moved tabs are activated,
- whether the target window is focused,
- where a moved tab is inserted in the target window,
- whether private tabs are routed within private windows,
- whether reloaded/already-open tabs should never be routed,
- ignored domains,
- ordered custom routing rules.

The toolbar button toggles routing on and off. It shows a green `on` badge when
routing is enabled and a red `off` badge when routing is disabled.

## Path-Based Rules

Custom rules split routing more specifically than the default domain route.
Rules are checked from top to bottom. The first matching rule wins.

Pattern syntax:

- Use `!` to capture one path segment for the window group and `*` as the final
  segment for the rest of the URL.
- Inside one path segment, `!` captures part of the segment. For example,
  `!-*` captures the part before the dash.
- If no custom rule matches, the extension falls back to domain routing when
  that option is enabled.

Example:

```text
https://github.com/gorhill/!/*
```

This routes repositories under the same GitHub account separately because the
repository segment is captured. For example,
[gorhill/uBlock](https://github.com/gorhill/uBlock) routes as its own window
group:

- `https://github.com/gorhill/uBlock/...` routes with
  `github.com/gorhill/uBlock`.
- `https://github.com/gorhill/uMatrix/...` routes with
  `github.com/gorhill/uMatrix`.

So each repository can keep its own Firefox window even though all URLs share
`github.com`.

GitLab SaaS example:

```text
https://gitlab.com/gitlab-org/!/-/issues/*
```

This routes GitLab issue URLs by project:

- `https://gitlab.com/gitlab-org/gitlab/-/issues/12345` routes with
  `gitlab.com/gitlab-org/gitlab`.
- `https://gitlab.com/gitlab-org/omnibus-gitlab/-/issues/12345` routes with
  `gitlab.com/gitlab-org/omnibus-gitlab`.

## Dev Install

1. Open Firefox.
2. Go to `about:debugging`.
3. Open `This Firefox`.
4. Click `Load Temporary Add-on...`.
5. Select `manifest.json` from this directory.

Temporary add-ons are removed when Firefox exits.

After changing extension files, return to `about:debugging` and click `Reload`
for the extension. After changing settings, click `Save Settings` in the
extension preferences.

## Prod Install

For a permanent install in regular Firefox, package and sign the extension.
Firefox release and beta builds require Mozilla-signed extensions.

Create an unsigned local package from the repository root:

```sh
./scripts/package.sh
```

Then submit that XPI for signing through Mozilla Add-ons. For personal
self-distribution, choose the unlisted/self-distributed signing path. Install
the signed XPI in Firefox via `about:addons`, the gear menu, and
`Install Add-on From File...`.

Unsigned XPI files are only suitable for temporary development loading, or for
Firefox Developer Edition, Nightly, ESR, or unbranded builds configured to allow
unsigned extensions.

## Test Cases

Run the matcher regression tests locally:

```sh
node test-settings.js
```

### Domain Routing

1. Open window A with `https://www.heise.de`.
2. Open window B.
3. In window B, open `https://www.heise.de/newsticker`.
4. Expected: the new tab moves to window A.

### Path Rule Routing

1. Open the extension preferences.
2. Add this rule: `https://github.com/gorhill/!/*`.
3. Save settings.
4. Open window A with `https://github.com/gorhill/uBlock`.
5. Open window B with `https://github.com/gorhill/uMatrix`.
6. Open `https://github.com/gorhill/uBlock/issues` from another window
   or app.
7. Expected: the new tab moves to window A.
8. Open `https://github.com/gorhill/uMatrix/issues` from another
   window or app.
9. Expected: the new tab moves to window B.

## Behavior

- Only `http:` and `https:` tabs are routed.
- Internal URLs such as `about:`, `moz-extension:`, `chrome:`, `file:`, and
  `view-source:` are ignored.
- If a tab starts as `about:blank` or `about:newtab`, the background script waits
  briefly and also listens for `tabs.onUpdated`.
- Reloaded tabs are not routed by default. The update listener is still used for
  newly-created tabs whose URL arrives after the create event.
- Private tabs are only compared with private tabs. Normal and private windows
  are never mixed.
- A moved tab is temporarily marked so it is not moved repeatedly.
- If the tab is moved to another window, it can be inserted at the end of that
  window, after the matching tab, or before the matching tab.
- The moved tab is activated and the target window is focused by default. Both
  options can be changed in the extension preferences.

## Manifest Choice

This extension uses Manifest V3 for Firefox with a script-based background page:

```json
"background": {
  "scripts": ["settings.js", "background.js"]
}
```

Firefox does not use `background.service_worker` for this extension.

## Known Limitations

- External app links are routed after Firefox opens the tab, not before.
- Domain detection is intentionally simple for the MVP: it lowercases the
  hostname, removes a leading `www.`, and uses the last two labels. This is not
  correct for public suffix cases such as `example.co.uk`.
- Firefox may initialize temporary extensions after the very first browser-start
  tabs have already opened.

## License

Apache-2.0. See [LICENSE](LICENSE).
