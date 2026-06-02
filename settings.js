"use strict";

(function exposeSettings(global) {
  const STORAGE_KEY = "domainWindowRouterSettings";
  const TARGET_TAB_POSITIONS = Object.freeze({
    END: "end",
    AFTER_MATCH: "afterMatch",
    BEFORE_MATCH: "beforeMatch"
  });
  const SETTINGS_LIMITS = Object.freeze({
    maxIgnoredDomains: 500,
    maxIgnoredDomainLength: 253,
    maxIgnoredDomainsTextLength: 200000,
    maxRoutingRules: 100,
    maxRuleNameLength: 120,
    maxRulePatternLength: 1000,
    maxPatternPathSegments: 20,
    maxPatternSegmentLength: 200,
    maxCapturesPerSegment: 4,
    maxWildcardsPerSegment: 1
  });

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    domainRoutingEnabled: true,
    activateMovedTab: true,
    focusTargetWindow: true,
    routePrivateTabs: true,
    neverRouteReloadedTabs: true,
    targetTabPosition: TARGET_TAB_POSITIONS.AFTER_MATCH,
    ignoredDomains: [],
    routingRules: []
  });

  function normalizeSettings(rawSettings) {
    const source = isObject(rawSettings) ? rawSettings : {};

    return {
      enabled: source.enabled !== false,
      domainRoutingEnabled: source.domainRoutingEnabled !== false,
      activateMovedTab: source.activateMovedTab !== false,
      focusTargetWindow: source.focusTargetWindow !== false,
      routePrivateTabs: source.routePrivateTabs !== false,
      neverRouteReloadedTabs: source.neverRouteReloadedTabs !== false,
      targetTabPosition: normalizeTargetTabPosition(source.targetTabPosition),
      ignoredDomains: normalizeIgnoredDomains(source.ignoredDomains),
      routingRules: normalizeRoutingRules(source.routingRules)
    };
  }

  function normalizeTargetTabPosition(value) {
    const allowedValues = new Set(Object.values(TARGET_TAB_POSITIONS));
    return allowedValues.has(value) ? value : DEFAULT_SETTINGS.targetTabPosition;
  }

  function normalizeRoutingRules(rawRules) {
    if (!Array.isArray(rawRules)) {
      return [];
    }

    return rawRules
      .slice(0, SETTINGS_LIMITS.maxRoutingRules)
      .map((rule, index) => normalizeRoutingRule(rule, index))
      .filter((rule) => rule.pattern);
  }

  function normalizeRoutingRule(rawRule, index) {
    const source = isObject(rawRule) ? rawRule : {};
    const fallbackId = `rule-${index + 1}`;

    return {
      id: normalizeId(source.id, fallbackId),
      enabled: source.enabled !== false,
      name: String(source.name || "")
        .trim()
        .slice(0, SETTINGS_LIMITS.maxRuleNameLength),
      pattern: normalizeRulePattern(source.pattern),
      caseSensitivePath: source.caseSensitivePath === true
    };
  }

  function normalizeIgnoredDomains(value) {
    const values = Array.isArray(value)
      ? value.slice(0, SETTINGS_LIMITS.maxIgnoredDomains)
      : String(value || "")
        .slice(0, SETTINGS_LIMITS.maxIgnoredDomainsTextLength)
        .split(/[\n,]/)
        .map((item) => item.trim());

    const uniqueDomains = new Set();

    for (const item of values) {
      if (uniqueDomains.size >= SETTINGS_LIMITS.maxIgnoredDomains) {
        break;
      }

      const domain = normalizeHostname(item);
      if (domain) {
        uniqueDomains.add(domain);
      }
    }

    return Array.from(uniqueDomains).sort();
  }

  function normalizeRulePattern(value) {
    const pattern = String(value || "").trim();
    return pattern.length <= SETTINGS_LIMITS.maxRulePatternLength
      ? pattern
      : "";
  }

  function normalizeId(value, fallback) {
    const normalized = String(value || "")
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    return normalized || fallback;
  }

  function compileRoutingRules(rules) {
    const compiledRules = [];
    const invalidRules = [];

    for (const rule of rules || []) {
      if (!rule) {
        continue;
      }

      const compiled = compileRulePattern(rule.pattern, rule.caseSensitivePath);
      if (compiled.ok) {
        compiledRules.push({
          ...rule,
          compiled
        });
        continue;
      }

      invalidRules.push({
        rule,
        error: compiled.error
      });
    }

    return {
      compiledRules,
      invalidRules
    };
  }

  function findMatchingRuleRoute(parsedUrl, rules) {
    for (const rule of rules || []) {
      if (!rule || rule.enabled === false) {
        continue;
      }

      const compiled = rule.compiled || compileRulePattern(
        rule.pattern,
        rule.caseSensitivePath
      );
      if (!compiled.ok) {
        continue;
      }

      const match = matchRoutingRule(parsedUrl, compiled);
      if (match) {
        return {
          ruleId: rule.id,
          routeKey: match.routeKey
        };
      }
    }

    return null;
  }

  function matchRoutingRule(parsedUrl, compiled) {
    const actualHost = normalizeHostname(parsedUrl.hostname);
    if (actualHost !== compiled.host) {
      return null;
    }

    const pathSegments = splitPathSegments(parsedUrl.pathname);
    const routeParts = [compiled.host];
    let pathIndex = 0;

    for (const token of compiled.tokens) {
      if (token.kind === "wildcard") {
        break;
      }

      const actualSegment = pathSegments[pathIndex];
      if (!actualSegment) {
        return null;
      }

      if (token.kind === "literal") {
        if (!segmentsEqual(actualSegment, token.value, compiled.caseSensitivePath)) {
          return null;
        }

        routeParts.push(normalizePathKeyPart(token.value, compiled.caseSensitivePath));
        pathIndex += 1;
        continue;
      }

      if (token.kind === "capture") {
        routeParts.push(normalizePathKeyPart(actualSegment, compiled.caseSensitivePath));
        pathIndex += 1;
        continue;
      }

      if (token.kind === "segmentPattern") {
        const match = actualSegment.match(token.regex);
        if (!match) {
          return null;
        }

        if (token.captureCount > 0) {
          routeParts.push(
            ...match
              .slice(1)
              .filter((value) => value)
              .map((value) => normalizePathKeyPart(value, compiled.caseSensitivePath))
          );
        } else {
          routeParts.push(normalizePathKeyPart(actualSegment, compiled.caseSensitivePath));
        }

        pathIndex += 1;
      }
    }

    const lastToken = compiled.tokens.at(-1);
    const hasRestWildcard =
      lastToken?.kind === "wildcard" ||
      lastToken?.restWildcard === true;

    if (!hasRestWildcard && pathIndex !== pathSegments.length) {
      return null;
    }

    return {
      routeKey: routeParts.join("/")
    };
  }

  function compileRulePattern(pattern, caseSensitivePath) {
    const parsed = parsePatternUrl(pattern);
    if (!parsed.ok) {
      return parsed;
    }

    const host = normalizeHostname(parsed.url.hostname);
    if (!host) {
      return {
        ok: false,
        error: "Pattern needs a host."
      };
    }

    const pathTokens = tokenizePatternPath(
      parsed.url.pathname,
      caseSensitivePath === true
    );
    if (!pathTokens.ok) {
      return pathTokens;
    }

    const tokens = pathTokens.tokens;
    const wildcardIndex = tokens.findIndex((token) => token.kind === "wildcard");

    if (wildcardIndex !== -1 && wildcardIndex !== tokens.length - 1) {
      return {
        ok: false,
        error: "A * wildcard must be the last path segment."
      };
    }

    return {
      ok: true,
      host,
      tokens,
      caseSensitivePath: caseSensitivePath === true
    };
  }

  function parsePatternUrl(pattern) {
    const rawPattern = String(pattern || "").trim();
    if (!rawPattern) {
      return {
        ok: false,
        error: "Pattern is required."
      };
    }

    if (rawPattern.length > SETTINGS_LIMITS.maxRulePatternLength) {
      return {
        ok: false,
        error: `Pattern is too long. Use ${SETTINGS_LIMITS.maxRulePatternLength} characters or fewer.`
      };
    }

    const preparedPattern = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawPattern)
      ? rawPattern
      : `https://${rawPattern}`;

    try {
      const url = new URL(preparedPattern);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return {
          ok: false,
          error: "Only http and https patterns are supported."
        };
      }

      return {
        ok: true,
        url
      };
    } catch (error) {
      return {
        ok: false,
        error: "Pattern is not a valid URL."
      };
    }
  }

  function tokenizePatternPath(pathname, caseSensitivePath) {
    const segments = splitPathSegments(pathname);
    if (segments.length > SETTINGS_LIMITS.maxPatternPathSegments) {
      return {
        ok: false,
        error: `Pattern has too many path segments. Use ${SETTINGS_LIMITS.maxPatternPathSegments} or fewer.`
      };
    }

    const tokens = [];
    for (const segment of segments) {
      const token = tokenizePatternSegment(segment, caseSensitivePath);
      if (!token.ok) {
        return token;
      }

      tokens.push(token.value);
    }

    return {
      ok: true,
      tokens
    };
  }

  function tokenizePatternSegment(segment, caseSensitivePath) {
    if (segment.length > SETTINGS_LIMITS.maxPatternSegmentLength) {
      return {
        ok: false,
        error: `Pattern path segments must be ${SETTINGS_LIMITS.maxPatternSegmentLength} characters or fewer.`
      };
    }

    if (segment === "*") {
      return {
        ok: true,
        value: { kind: "wildcard" }
      };
    }

    if (segment === "!") {
      return {
        ok: true,
        value: { kind: "capture" }
      };
    }

    if (segment.includes("*") && !segment.endsWith("*")) {
      return {
        ok: false,
        error: "A * wildcard inside a path segment must be the last character."
      };
    }

    if (countCharacters(segment, "*") > SETTINGS_LIMITS.maxWildcardsPerSegment) {
      return {
        ok: false,
        error: `A path segment can contain at most ${SETTINGS_LIMITS.maxWildcardsPerSegment} wildcard.`
      };
    }

    if (countCharacters(segment, "!") > SETTINGS_LIMITS.maxCapturesPerSegment) {
      return {
        ok: false,
        error: `A path segment can contain at most ${SETTINGS_LIMITS.maxCapturesPerSegment} captures.`
      };
    }

    if (segment.includes("!") || segment.includes("*")) {
      return {
        ok: true,
        value: compileSegmentPattern(segment, caseSensitivePath)
      };
    }

    return {
      ok: true,
      value: {
        kind: "literal",
        value: segment
      }
    };
  }

  function compileSegmentPattern(segment, caseSensitivePath) {
    let regexSource = "^";
    let captureCount = 0;

    for (const char of segment) {
      if (char === "!") {
        regexSource += "(.+?)";
        captureCount += 1;
        continue;
      }

      if (char === "*") {
        regexSource += ".*";
        continue;
      }

      regexSource += escapeRegExp(char);
    }

    regexSource += "$";

    return {
      kind: "segmentPattern",
      regex: new RegExp(regexSource, caseSensitivePath ? "" : "i"),
      captureCount,
      restWildcard: segment.endsWith("*")
    };
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function splitPathSegments(pathname) {
    return String(pathname || "")
      .split("/")
      .filter((segment) => segment.length > 0);
  }

  function countCharacters(value, character) {
    return Array.from(String(value)).filter((item) => item === character).length;
  }

  function segmentsEqual(actual, expected, caseSensitivePath) {
    if (caseSensitivePath) {
      return actual === expected;
    }

    return actual.toLowerCase() === expected.toLowerCase();
  }

  function normalizePathKeyPart(value, caseSensitivePath) {
    return caseSensitivePath ? value : String(value).toLowerCase();
  }

  function getRegistrableDomain(hostname) {
    const normalized = normalizeHostname(hostname);
    if (!normalized) {
      return null;
    }

    if (isIpAddressLike(normalized) || normalized === "localhost") {
      return normalized;
    }

    const labels = normalized.split(".").filter(Boolean);
    if (labels.length <= 2) {
      return labels.join(".");
    }

    return labels.slice(-2).join(".");
  }

  function normalizeHostname(hostname) {
    return String(hostname || "")
      .trim()
      .slice(0, SETTINGS_LIMITS.maxIgnoredDomainLength)
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\.$/, "")
      .replace(/^www\./, "");
  }

  function isIpAddressLike(hostname) {
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
  }

  function parseHttpUrl(url) {
    if (!url) {
      return null;
    }

    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? parsed
        : null;
    } catch (error) {
      return null;
    }
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  global.DomainWindowRouterSettings = {
    STORAGE_KEY,
    TARGET_TAB_POSITIONS,
    SETTINGS_LIMITS,
    DEFAULT_SETTINGS,
    normalizeSettings,
    normalizeIgnoredDomains,
    normalizeHostname,
    getRegistrableDomain,
    parseHttpUrl,
    compileRulePattern,
    compileRoutingRules,
    findMatchingRuleRoute
  };
})(globalThis);
