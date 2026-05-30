"use strict";

const {
  STORAGE_KEY,
  TARGET_TAB_POSITIONS,
  normalizeSettings,
  normalizeHostname,
  getRegistrableDomain,
  parseHttpUrl,
  compileRulePattern,
  findMatchingRuleRoute
} = DomainWindowRouterSettings;

const ROUTING_TIMING = Object.freeze({
  debounceMs: 50,
  retryDelaysMs: [150, 500, 1000, 2000],
  movedRecentlyMs: 3000
});

let routingSettings = normalizeSettings({});
let ignoredDomains = new Set(routingSettings.ignoredDomains);
let invalidRuleWarnings = new Set();

const pendingRoutes = new Map();
const routingInProgress = new Set();
const movedRecently = new Map();
const tabsEligibleForUpdateRouting = new Set();
const settingsReady = loadRoutingSettings();

browser.action.onClicked.addListener(() => {
  toggleRouterEnabled().catch((error) => {
    console.error("URL-to-Window Router: could not toggle routing", { error });
  });
});

browser.tabs.onCreated.addListener((tab) => {
  tabsEligibleForUpdateRouting.add(tab.id);
  scheduleRoute(tab.id, "created", 0, ROUTING_TIMING.debounceMs);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    (changeInfo.url || changeInfo.status === "complete") &&
    shouldRouteUpdatedTab(tabId)
  ) {
    scheduleRoute(tabId, "updated", 0, ROUTING_TIMING.debounceMs);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  clearPendingRoute(tabId);
  clearMovedRecently(tabId);
  routingInProgress.delete(tabId);
  tabsEligibleForUpdateRouting.delete(tabId);
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]) {
    return;
  }

  setRoutingSettings(changes[STORAGE_KEY].newValue);
});

function shouldRouteUpdatedTab(tabId) {
  return (
    !routingSettings.neverRouteReloadedTabs ||
    tabsEligibleForUpdateRouting.has(tabId)
  );
}

function scheduleRoute(tabId, reason, attempt, delayMs) {
  if (!isUsableTabId(tabId) || !routingSettings.enabled) {
    return;
  }

  clearPendingRoute(tabId);

  const timeoutId = setTimeout(() => {
    pendingRoutes.delete(tabId);
    maybeRouteTab(tabId, reason, attempt).catch((error) => {
      console.error("URL-to-Window Router: routing failed", {
        tabId,
        reason,
        error
      });
    });
  }, delayMs);

  pendingRoutes.set(tabId, timeoutId);
}

async function maybeRouteTab(tabId, reason, attempt) {
  await settingsReady;

  const settings = routingSettings;
  if (
    movedRecently.has(tabId) ||
    routingInProgress.has(tabId) ||
    !settings.enabled
  ) {
    return;
  }

  routingInProgress.add(tabId);

  try {
    const tab = await getTabOrNull(tabId);
    if (!tab) {
      tabsEligibleForUpdateRouting.delete(tabId);
      return;
    }

    if (tab.incognito && !settings.routePrivateTabs) {
      return;
    }

    const url = getTabUrl(tab);
    if (!isHttpUrl(url)) {
      if (!isRetryableTemporaryUrl(url)) {
        tabsEligibleForUpdateRouting.delete(tabId);
      }

      scheduleRetryIfUseful(tabId, url, reason, attempt);
      return;
    }

    tabsEligibleForUpdateRouting.delete(tabId);

    const currentRoute = getRouteForUrl(url, settings);
    if (!currentRoute || isIgnoredRoute(currentRoute)) {
      return;
    }

    const allTabs = await browser.tabs.query({});
    if (hasMatchingTabInCurrentWindow({
      allTabs,
      currentTab: tab,
      currentRoute,
      settings
    })) {
      return;
    }

    const targetPlacement = findTargetPlacement({
      allTabs,
      currentTab: tab,
      currentRoute,
      settings
    });

    if (!targetPlacement) {
      return;
    }

    markMovedRecently(tab.id);
    clearPendingRoute(tab.id);

    await browser.tabs.move(tab.id, {
      windowId: targetPlacement.windowId,
      index: targetPlacement.index
    });

    if (settings.activateMovedTab) {
      await browser.tabs.update(tab.id, { active: true });
    }

    if (settings.focusTargetWindow) {
      await browser.windows.update(targetPlacement.windowId, { focused: true });
    }
  } catch (error) {
    console.warn("URL-to-Window Router: could not route tab", {
      tabId,
      reason,
      error
    });
  } finally {
    routingInProgress.delete(tabId);
  }
}

async function loadRoutingSettings() {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    setRoutingSettings(stored[STORAGE_KEY]);
  } catch (error) {
    console.warn("URL-to-Window Router: could not load settings, using defaults", {
      error
    });
    setRoutingSettings({});
  }
}

function setRoutingSettings(rawSettings) {
  routingSettings = normalizeSettings(rawSettings);
  ignoredDomains = new Set(routingSettings.ignoredDomains);
  reportInvalidRoutingRules(routingSettings.routingRules);
  updateActionState(routingSettings).catch((error) => {
    console.warn("URL-to-Window Router: could not update toolbar state", { error });
  });
}

async function toggleRouterEnabled() {
  await settingsReady;

  const nextSettings = normalizeSettings({
    ...routingSettings,
    enabled: !routingSettings.enabled
  });

  await browser.storage.local.set({
    [STORAGE_KEY]: nextSettings
  });
}

async function updateActionState(settings) {
  if (!browser.action) {
    return;
  }

  if (settings.enabled) {
    await browser.action.setBadgeText({ text: "on" });
    await browser.action.setBadgeBackgroundColor({ color: "#2f7d57" });
    await browser.action.setTitle({ title: "URL-to-Window Router: enabled" });
    return;
  }

  await browser.action.setBadgeText({ text: "off" });
  await browser.action.setBadgeBackgroundColor({ color: "#d70022" });
  await browser.action.setTitle({ title: "URL-to-Window Router: disabled" });
}

function reportInvalidRoutingRules(rules) {
  const nextWarnings = new Set();

  for (const rule of rules) {
    const validation = compileRulePattern(rule.pattern, rule.caseSensitivePath);
    if (validation.ok) {
      continue;
    }

    const warningKey = `${rule.id}:${rule.pattern}:${validation.error}`;
    nextWarnings.add(warningKey);

    if (!invalidRuleWarnings.has(warningKey)) {
      console.warn("URL-to-Window Router: invalid routing rule ignored", {
        rule,
        error: validation.error
      });
    }
  }

  invalidRuleWarnings = nextWarnings;
}

async function getTabOrNull(tabId) {
  try {
    return await browser.tabs.get(tabId);
  } catch (error) {
    console.warn("URL-to-Window Router: tab is no longer available", {
      tabId,
      error
    });
    return null;
  }
}

function scheduleRetryIfUseful(tabId, url, reason, attempt) {
  if (!isRetryableTemporaryUrl(url) || attempt >= ROUTING_TIMING.retryDelaysMs.length) {
    return;
  }

  scheduleRoute(
    tabId,
    `retry-after-${reason}`,
    attempt + 1,
    ROUTING_TIMING.retryDelaysMs[attempt]
  );
}

function hasMatchingTabInCurrentWindow({ allTabs, currentTab, currentRoute, settings }) {
  const currentIncognito = Boolean(currentTab.incognito);

  return allTabs.some((candidate) => {
    if (
      !candidate ||
      candidate.id === currentTab.id ||
      candidate.windowId !== currentTab.windowId ||
      Boolean(candidate.incognito) !== currentIncognito
    ) {
      return false;
    }

    const candidateRoute = getRouteForUrl(getTabUrl(candidate), settings);
    return Boolean(candidateRoute && candidateRoute.key === currentRoute.key);
  });
}

function findTargetPlacement({ allTabs, currentTab, currentRoute, settings }) {
  const currentIncognito = Boolean(currentTab.incognito);
  const matchesByWindow = new Map();

  for (const candidate of allTabs) {
    if (
      !candidate ||
      candidate.id === currentTab.id ||
      candidate.windowId === currentTab.windowId ||
      Boolean(candidate.incognito) !== currentIncognito
    ) {
      continue;
    }

    const candidateRoute = getRouteForUrl(getTabUrl(candidate), settings);
    if (!candidateRoute || candidateRoute.key !== currentRoute.key) {
      continue;
    }

    const existing = matchesByWindow.get(candidate.windowId) || {
      count: 0,
      hasActiveTab: false,
      hasPinnedTab: false,
      insertionIndex: getInsertionIndex(candidate, settings.targetTabPosition),
      insertionTabScore: -1
    };

    const tabScore =
      (candidate.active ? 100 : 0) +
      (candidate.pinned ? 10 : 0) +
      candidate.index;

    existing.count += 1;
    existing.hasActiveTab ||= Boolean(candidate.active);
    existing.hasPinnedTab ||= Boolean(candidate.pinned);

    if (tabScore > existing.insertionTabScore) {
      existing.insertionTabScore = tabScore;
      existing.insertionIndex = getInsertionIndex(candidate, settings.targetTabPosition);
    }

    matchesByWindow.set(candidate.windowId, existing);
  }

  let bestPlacement = null;
  let bestScore = -1;

  for (const [windowId, match] of matchesByWindow) {
    const score =
      match.count * 10 +
      (match.hasActiveTab ? 2 : 0) +
      (match.hasPinnedTab ? 1 : 0);

    if (score > bestScore) {
      bestScore = score;
      bestPlacement = {
        windowId,
        index: settings.targetTabPosition === TARGET_TAB_POSITIONS.END
          ? -1
          : match.insertionIndex
      };
    }
  }

  return bestPlacement;
}

function getInsertionIndex(candidate, targetTabPosition) {
  if (targetTabPosition === TARGET_TAB_POSITIONS.BEFORE_MATCH) {
    return candidate.index;
  }

  return candidate.index + 1;
}

function isUsableTabId(tabId) {
  return Number.isInteger(tabId);
}

function getRouteForUrl(url, settings) {
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    return null;
  }

  const hostname = normalizeHostname(parsed.hostname);
  const domain = getRegistrableDomain(parsed.hostname);
  if (!domain) {
    return null;
  }

  const ruleMatch = findMatchingRuleRoute(parsed, settings.routingRules);
  if (ruleMatch) {
    return {
      key: `rule:${ruleMatch.routeKey}`,
      domain,
      hostname,
      ruleId: ruleMatch.ruleId
    };
  }

  if (!settings.domainRoutingEnabled) {
    return null;
  }

  return {
    key: `domain:${domain}`,
    domain,
    hostname,
    ruleId: null
  };
}

function isIgnoredRoute(route) {
  return ignoredDomains.has(route.domain) || ignoredDomains.has(route.hostname);
}

function isHttpUrl(url) {
  return parseHttpUrl(url) !== null;
}

function isRetryableTemporaryUrl(url) {
  return !url || url === "about:blank" || url === "about:newtab";
}

function getTabUrl(tab) {
  return tab.url || tab.pendingUrl || "";
}

function markMovedRecently(tabId) {
  clearMovedRecently(tabId);

  const timeoutId = setTimeout(() => {
    movedRecently.delete(tabId);
  }, ROUTING_TIMING.movedRecentlyMs);

  movedRecently.set(tabId, timeoutId);
}

function clearMovedRecently(tabId) {
  const timeoutId = movedRecently.get(tabId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    movedRecently.delete(tabId);
  }
}

function clearPendingRoute(tabId) {
  const timeoutId = pendingRoutes.get(tabId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    pendingRoutes.delete(tabId);
  }
}
