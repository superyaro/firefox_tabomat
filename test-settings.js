"use strict";

const assert = require("assert/strict");

require("./settings.js");

const {
  findMatchingRuleRoute,
  getRegistrableDomain,
  normalizeSettings
} = globalThis.DomainWindowRouterSettings;

const gitProjectRule = {
  id: "git-projects",
  enabled: true,
  pattern: "https://github.com/gorhill/!/*",
  caseSensitivePath: false
};

const trackIssueRule = {
  id: "youtrack-issues",
  enabled: true,
  pattern: "https://youtrack.jetbrains.com/issue/!-*",
  caseSensitivePath: false
};

assert.equal(
  findMatchingRuleRoute(
    new URL("https://github.com/gorhill/uBlock"),
    [gitProjectRule]
  ).routeKey,
  "github.com/gorhill/ublock"
);

assert.equal(
  findMatchingRuleRoute(
    new URL("https://github.com/gorhill/uBlock/"),
    [gitProjectRule]
  ).routeKey,
  "github.com/gorhill/ublock"
);

assert.equal(
  findMatchingRuleRoute(
    new URL("https://github.com/gorhill/uBlock/issues"),
    [gitProjectRule]
  ).routeKey,
  "github.com/gorhill/ublock"
);

assert.equal(
  findMatchingRuleRoute(
    new URL("https://github.com/gorhill/uMatrix"),
    [gitProjectRule]
  ).routeKey,
  "github.com/gorhill/umatrix"
);

assert.equal(
  findMatchingRuleRoute(
    new URL("https://github.com/other/uBlock"),
    [gitProjectRule]
  ),
  null
);

assert.equal(
  findMatchingRuleRoute(
    new URL("https://youtrack.jetbrains.com/issue/IDEA-380201/Open-browser-run-configuration-doesnt-launch-the-browser-JBoss-server"),
    [trackIssueRule]
  ).routeKey,
  "youtrack.jetbrains.com/issue/idea"
);

assert.equal(
  findMatchingRuleRoute(
    new URL("https://youtrack.jetbrains.com/issue/IDEA-380201"),
    [trackIssueRule]
  ).routeKey,
  "youtrack.jetbrains.com/issue/idea"
);

assert.equal(
  findMatchingRuleRoute(
    new URL("https://youtrack.jetbrains.com/issue/WI-12345/Another-title"),
    [trackIssueRule]
  ).routeKey,
  "youtrack.jetbrains.com/issue/wi"
);

assert.equal(getRegistrableDomain("www.heise.de"), "heise.de");

assert.equal(normalizeSettings({}).targetTabPosition, "afterMatch");
assert.equal(normalizeSettings({}).neverRouteReloadedTabs, true);
assert.equal(
  normalizeSettings({ neverRouteReloadedTabs: false }).neverRouteReloadedTabs,
  false
);
assert.equal(
  normalizeSettings({ targetTabPosition: "beforeMatch" }).targetTabPosition,
  "beforeMatch"
);
assert.equal(
  normalizeSettings({ targetTabPosition: "end" }).targetTabPosition,
  "end"
);
assert.equal(
  normalizeSettings({ targetTabPosition: "invalid" }).targetTabPosition,
  "afterMatch"
);

console.log("settings tests passed");
