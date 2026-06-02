"use strict";

const {
  STORAGE_KEY,
  TARGET_TAB_POSITIONS,
  normalizeSettings,
  normalizeHostname,
  getRegistrableDomain,
  parseHttpUrl,
  compileRoutingRules,
  findMatchingRuleRoute
} = DomainWindowRouterSettings;

const ROUTING_TIMING = Object.freeze({
  debounceMs: 50,
  retryDelaysMs: [150, 500, 1000, 2000],
  movedRecentlyMs: 3000
});

const initialRuntimeSettings = createRuntimeSettings({});
let routingSettings = initialRuntimeSettings.settings;
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

    if (!isTabEligibleForRouting(tab, settings)) {
      tabsEligibleForUpdateRouting.delete(tabId);
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

    const routePlan = await createRoutePlanForTab({
      currentTab: tab,
      currentRoute,
      settings
    });

    if (!routePlan) {
      return;
    }

    const confirmedRoutePlan = await confirmRoutePlan(routePlan, settings);
    if (!confirmedRoutePlan) {
      return;
    }

    await moveTabFromRoutePlan(confirmedRoutePlan, settings);
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

async function createRoutePlanForTab({ currentTab, currentRoute, settings }) {
  const allTabs = await browser.tabs.query({});

  if (hasMatchingTabInCurrentWindow({
    allTabs,
    currentTab,
    currentRoute,
    settings
  })) {
    return null;
  }

  const targetPlacement = findTargetPlacement({
    allTabs,
    currentTab,
    currentRoute,
    settings
  });

  return targetPlacement
    ? { currentTab, currentRoute, targetPlacement }
    : null;
}

async function confirmRoutePlan(routePlan, settings) {
  const currentTab = await getTabOrNull(routePlan.currentTab.id);
  if (!currentTab || !isTabEligibleForRouting(currentTab, settings)) {
    return null;
  }

  if (currentTab.windowId !== routePlan.currentTab.windowId) {
    return null;
  }

  const currentRoute = getRouteForUrl(getTabUrl(currentTab), settings);
  if (
    !currentRoute ||
    currentRoute.key !== routePlan.currentRoute.key ||
    isIgnoredRoute(currentRoute)
  ) {
    return null;
  }

  return createRoutePlanForTab({
    currentTab,
    currentRoute,
    settings
  });
}

async function moveTabFromRoutePlan(routePlan, settings) {
  const tabId = routePlan.currentTab.id;

  markMovedRecently(tabId);
  clearPendingRoute(tabId);

  try {
    await browser.tabs.move(tabId, {
      windowId: routePlan.targetPlacement.windowId,
      index: routePlan.targetPlacement.index
    });
  } catch (error) {
    clearMovedRecently(tabId);
    throw error;
  }

  if (settings.activateMovedTab) {
    await safelyActivateTab(tabId);
  }

  if (settings.focusTargetWindow) {
    await safelyFocusWindow(routePlan.targetPlacement.windowId);
  }
}

async function safelyActivateTab(tabId) {
  try {
    await browser.tabs.update(tabId, { active: true });
  } catch (error) {
    console.warn("URL-to-Window Router: moved tab could not be activated", {
      tabId,
      error
    });
  }
}

async function safelyFocusWindow(windowId) {
  try {
    await browser.windows.update(windowId, { focused: true });
  } catch (error) {
    console.warn("URL-to-Window Router: target window could not be focused", {
      windowId,
      error
    });
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
  const runtimeSettings = createRuntimeSettings(rawSettings);
  routingSettings = runtimeSettings.settings;
  ignoredDomains = new Set(routingSettings.ignoredDomains);
  reportInvalidRoutingRules(runtimeSettings.invalidRules);
  updateActionState(routingSettings).catch((error) => {
    console.warn("URL-to-Window Router: could not update toolbar state", { error });
  });
}

function createRuntimeSettings(rawSettings) {
  const settings = normalizeSettings(rawSettings);
  const compiled = compileRoutingRules(settings.routingRules);

  return {
    settings: {
      ...settings,
      compiledRoutingRules: compiled.compiledRules
    },
    invalidRules: compiled.invalidRules
  };
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

function reportInvalidRoutingRules(invalidRules) {
  const nextWarnings = new Set();

  for (const invalidRule of invalidRules) {
    const rule = invalidRule.rule;
    const warningKey = `${rule.id}:${rule.pattern}:${invalidRule.error}`;
    nextWarnings.add(warningKey);

    if (!invalidRuleWarnings.has(warningKey)) {
      console.warn("URL-to-Window Router: invalid routing rule ignored", {
        rule,
        error: invalidRule.error
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

function isTabEligibleForRouting(tab, settings) {
  if (
    !tab ||
    !isUsableTabId(tab.id) ||
    tab.pinned ||
    tab.hidden ||
    tab.discarded
  ) {
    return false;
  }

  return !(tab.incognito && !settings.routePrivateTabs);
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
  const tabsByWindow = groupTabsByWindow(allTabs);

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
      insertionIndex: getInsertionIndex(
        candidate,
        settings.targetTabPosition,
        currentTab,
        tabsByWindow.get(candidate.windowId) || []
      ),
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
      existing.insertionIndex = getInsertionIndex(
        candidate,
        settings.targetTabPosition,
        currentTab,
        tabsByWindow.get(candidate.windowId) || []
      );
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

function groupTabsByWindow(allTabs) {
  const tabsByWindow = new Map();

  for (const tab of allTabs) {
    if (!tab || !Number.isInteger(tab.windowId)) {
      continue;
    }

    const tabs = tabsByWindow.get(tab.windowId) || [];
    tabs.push(tab);
    tabsByWindow.set(tab.windowId, tabs);
  }

  for (const tabs of tabsByWindow.values()) {
    tabs.sort((a, b) => a.index - b.index);
  }

  return tabsByWindow;
}

function getInsertionIndex(candidate, targetTabPosition, currentTab, targetWindowTabs) {
  if (targetTabPosition === TARGET_TAB_POSITIONS.BEFORE_MATCH) {
    return getSafeInsertionIndex(candidate.index, currentTab, targetWindowTabs);
  }

  return getSafeInsertionIndex(candidate.index + 1, currentTab, targetWindowTabs);
}

function getSafeInsertionIndex(index, currentTab, targetWindowTabs) {
  if (currentTab.pinned) {
    return index;
  }

  const safeIndex = Math.max(index, getFirstUnpinnedIndex(targetWindowTabs));
  return safeIndex >= targetWindowTabs.length ? -1 : safeIndex;
}

function getFirstUnpinnedIndex(tabs) {
  const firstUnpinned = tabs.find((tab) => !tab.pinned);
  return firstUnpinned ? firstUnpinned.index : tabs.length;
}

function isUsableTabId(tabId) {
  return Number.isInteger(tabId) && tabId >= 0;
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

  const ruleMatch = findMatchingRuleRoute(
    parsed,
    settings.compiledRoutingRules || settings.routingRules
  );
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
