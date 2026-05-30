"use strict";

const {
  STORAGE_KEY,
  normalizeSettings,
  compileRulePattern
} = DomainWindowRouterSettings;

const form = document.getElementById("settings-form");
const enabledInput = document.getElementById("enabled");
const domainRoutingEnabledInput = document.getElementById("domain-routing-enabled");
const activateMovedTabInput = document.getElementById("activate-moved-tab");
const focusTargetWindowInput = document.getElementById("focus-target-window");
const routePrivateTabsInput = document.getElementById("route-private-tabs");
const neverRouteReloadedTabsInput = document.getElementById("never-route-reloaded-tabs");
const targetTabPositionInput = document.getElementById("target-tab-position");
const ignoredDomainsInput = document.getElementById("ignored-domains");
const addRuleButton = document.getElementById("add-rule");
const resetSettingsButton = document.getElementById("reset-settings");
const rulesList = document.getElementById("rules-list");
const emptyRules = document.getElementById("empty-rules");
const ruleTemplate = document.getElementById("rule-template");
const statusMessage = document.getElementById("status");

initOptionsPage().catch((error) => {
  console.error("URL-to-Window Router: options page failed", { error });
  showStatus("Could not load settings.", true);
});

async function initOptionsPage() {
  bindEvents();
  await loadSettings();
}

function bindEvents() {
  form.addEventListener("submit", saveSettings);
  addRuleButton.addEventListener("click", addRule);
  resetSettingsButton.addEventListener("click", resetSettings);
  rulesList.addEventListener("click", handleRuleAction);
  rulesList.addEventListener("input", handleRuleInput);
}

async function loadSettings() {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  populateForm(normalizeSettings(stored[STORAGE_KEY]));
}

function populateForm(settings) {
  enabledInput.checked = settings.enabled;
  domainRoutingEnabledInput.checked = settings.domainRoutingEnabled;
  activateMovedTabInput.checked = settings.activateMovedTab;
  focusTargetWindowInput.checked = settings.focusTargetWindow;
  routePrivateTabsInput.checked = settings.routePrivateTabs;
  neverRouteReloadedTabsInput.checked = settings.neverRouteReloadedTabs;
  targetTabPositionInput.value = settings.targetTabPosition;
  ignoredDomainsInput.value = settings.ignoredDomains.join("\n");
  renderRules(settings.routingRules);
}

function renderRules(rules) {
  rulesList.textContent = "";
  emptyRules.hidden = rules.length > 0;

  rules.forEach((rule, index) => {
    rulesList.append(createRuleRow(rule, index, rules.length));
  });
}

function createRuleRow(rule, index, count) {
  const row = ruleTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.ruleId = rule.id || createRuleId();

  const enabled = getRuleField(row, "enabled");
  const name = getRuleField(row, "name");
  const pattern = getRuleField(row, "pattern");
  const caseSensitivePath = getRuleField(row, "caseSensitivePath");

  enabled.checked = rule.enabled !== false;
  name.value = rule.name || "";
  pattern.value = rule.pattern || "";
  caseSensitivePath.checked = rule.caseSensitivePath === true;

  row.querySelector('[data-action="move-up"]').disabled = index === 0;
  row.querySelector('[data-action="move-down"]').disabled = index === count - 1;

  validateRuleRow(row);
  return row;
}

function addRule() {
  const rules = collectRules();
  rules.push({
    id: createRuleId(),
    enabled: true,
    name: "GitHub repositories",
    pattern: "https://github.com/gorhill/!/*",
    caseSensitivePath: false
  });
  renderRules(rules);
  showStatus("");
}

function handleRuleAction(event) {
  const action = event.target.dataset.action;
  if (!action) {
    return;
  }

  const row = event.target.closest(".rule-row");
  const rows = Array.from(rulesList.querySelectorAll(".rule-row"));
  const index = rows.indexOf(row);
  if (index === -1) {
    return;
  }

  const rules = collectRules();

  if (action === "remove") {
    rules.splice(index, 1);
  } else if (action === "move-up" && index > 0) {
    [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
  } else if (action === "move-down" && index < rules.length - 1) {
    [rules[index + 1], rules[index]] = [rules[index], rules[index + 1]];
  }

  renderRules(rules);
  showStatus("");
}

function handleRuleInput(event) {
  const row = event.target.closest(".rule-row");
  if (row) {
    validateRuleRow(row);
  }
  showStatus("");
}

async function saveSettings(event) {
  event.preventDefault();

  if (!validateAllRules()) {
    showStatus("Fix invalid rules before saving.", true);
    return;
  }

  const settings = normalizeSettings({
    enabled: enabledInput.checked,
    domainRoutingEnabled: domainRoutingEnabledInput.checked,
    activateMovedTab: activateMovedTabInput.checked,
    focusTargetWindow: focusTargetWindowInput.checked,
    routePrivateTabs: routePrivateTabsInput.checked,
    neverRouteReloadedTabs: neverRouteReloadedTabsInput.checked,
    targetTabPosition: targetTabPositionInput.value,
    ignoredDomains: ignoredDomainsInput.value,
    routingRules: collectRules()
  });

  await browser.storage.local.set({
    [STORAGE_KEY]: settings
  });

  populateForm(settings);
  showStatus("Saved.");
}

async function resetSettings() {
  const confirmed = window.confirm("Reset URL-to-Window Router settings?");
  if (!confirmed) {
    return;
  }

  const settings = normalizeSettings({});
  await browser.storage.local.set({
    [STORAGE_KEY]: settings
  });

  populateForm(settings);
  showStatus("Reset.");
}

function collectRules() {
  return Array.from(rulesList.querySelectorAll(".rule-row")).map((row) => ({
    id: row.dataset.ruleId || createRuleId(),
    enabled: getRuleField(row, "enabled").checked,
    name: getRuleField(row, "name").value.trim(),
    pattern: getRuleField(row, "pattern").value.trim(),
    caseSensitivePath: getRuleField(row, "caseSensitivePath").checked
  }));
}

function validateAllRules() {
  return Array.from(rulesList.querySelectorAll(".rule-row"))
    .map((row) => validateRuleRow(row))
    .every(Boolean);
}

function validateRuleRow(row) {
  const pattern = getRuleField(row, "pattern").value.trim();
  const caseSensitivePath = getRuleField(row, "caseSensitivePath").checked;
  const error = row.querySelector('[data-field="error"]');

  if (!pattern) {
    setRuleError(row, error, "Pattern is required.");
    return false;
  }

  const validation = compileRulePattern(pattern, caseSensitivePath);
  if (!validation.ok) {
    setRuleError(row, error, validation.error);
    return false;
  }

  setRuleError(row, error, "");
  return true;
}

function setRuleError(row, errorElement, message) {
  row.dataset.invalid = message ? "true" : "false";
  errorElement.textContent = message;
}

function getRuleField(row, field) {
  return row.querySelector(`[data-field="${field}"]`);
}

function createRuleId() {
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function showStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.dataset.error = isError ? "true" : "false";
}
