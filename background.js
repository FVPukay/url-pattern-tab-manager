const syncGet = (keys) => new Promise((res) => chrome.storage.sync.get(keys, res));
const syncSet = (obj) => new Promise((res) => chrome.storage.sync.set(obj, res));
const localGet = (keys) => new Promise((res) => chrome.storage.local.get(keys, res));
const localSet = (obj) => new Promise((res) => chrome.storage.local.set(obj, res));

const GROUP_MAP_KEY = 'groupMap';

// ------------------ Helpers ------------------

function normalizeUrl(url) {
    return url.replace(/^(https?:\/\/)?(www\.)?/i, '');
}

function matchesPattern(url, pattern) {
    if (!url || !pattern) return false;
    const normalizedUrl = normalizeUrl(url);
    const normalizedPattern = normalizeUrl(pattern);
    const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('^' + escaped.replace(/\*/g, '.*'), 'i');
    return regex.test(normalizedUrl);
}

function canonicalizePattern(p) {
    if (!p) return '';
    return p.trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/i, '').replace(/\/+$/, '');
}

// ------------------ Group Tabs / Ungroup Tabs ------------------

async function groupMatchingTabs(pattern) {
    const tabs = await chrome.tabs.query({});
    const tabsToGroup = tabs.filter(t => t.url && matchesPattern(t.url, pattern));
    if (tabsToGroup.length < 1) return;

    const existingGroups = await chrome.tabGroups.query({ title: pattern });
    let groupId;
    if (existingGroups && existingGroups.length > 0) {
        groupId = existingGroups[0].id;
        await chrome.tabs.group({ tabIds: tabsToGroup.map(t => t.id), groupId });
    } else {
        groupId = await chrome.tabs.group({ tabIds: tabsToGroup.map(t => t.id) });
        await chrome.tabGroups.update(groupId, { title: pattern });
    }

    const { [GROUP_MAP_KEY]: groupMap = {} } = await localGet([GROUP_MAP_KEY]);
    groupMap[String(groupId)] = pattern;
    await localSet({ [GROUP_MAP_KEY]: groupMap });
}

async function ungroupTabsForPattern(pattern) {
    const { [GROUP_MAP_KEY]: groupMap = {} } = await localGet([GROUP_MAP_KEY]);
    const groupIdsToUngroup = [];
    for (const [gid, savedPattern] of Object.entries(groupMap)) {
        if (canonicalizePattern(savedPattern) === canonicalizePattern(pattern)) {
            groupIdsToUngroup.push(Number(gid));
        }
    }

    for (const groupId of groupIdsToUngroup) {
        const tabs = await chrome.tabs.query({ groupId });
        if (tabs.length > 0) await chrome.tabs.ungroup(tabs.map(t => t.id));
        delete groupMap[String(groupId)];
    }
    await localSet({ [GROUP_MAP_KEY]: groupMap });
}

// ------------------ Handle messages from popup ------------------

chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
    if (request.action === 'groupTabs') {
        await groupMatchingTabs(request.pattern);
        sendResponse?.({ ok: true });
        return true;
    }

    if (request.action === 'ungroupTabs') {
        await ungroupTabsForPattern(request.pattern);
        sendResponse?.({ ok: true });
        return true;
    }
});

// ------------------ Auto-group new or updated tabs ------------------

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url && tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
        const { patterns = [] } = await syncGet(['patterns']);
        for (const p of patterns) {
            if (matchesPattern(changeInfo.url, p)) await groupMatchingTabs(p);
        }
    }
});

chrome.tabs.onCreated.addListener((tab) => {
    setTimeout(async () => {
        if (!tab.url) return;
        const { patterns = [] } = await syncGet(['patterns']);
        for (const p of patterns) {
            if (matchesPattern(tab.url, p)) await groupMatchingTabs(p);
        }
    }, 500);
});

// ------------------ Chrome UI Tab Groups ------------------

// Debounce to avoid partial titles being saved
const saveDebounce = new Map();
const DEBOUNCE_MS = 650;

async function addOrReplacePatternForGroup(groupId, rawTitle) {
    const title = (rawTitle || '').trim();
    if (!title) return;
    const newPattern = title;
    const { patterns = [] } = await syncGet(['patterns']);
    const { [GROUP_MAP_KEY]: groupMap = {} } = await localGet([GROUP_MAP_KEY]);

    const prevForGroup = groupMap[String(groupId)];
    const canonNew = canonicalizePattern(newPattern);

    if (prevForGroup && canonicalizePattern(prevForGroup) !== canonNew) {
        const filtered = patterns.filter(p => canonicalizePattern(p) !== canonicalizePattern(prevForGroup));
        const exists = filtered.some(p => canonicalizePattern(p) === canonNew);
        const next = exists ? filtered : [...filtered, newPattern];
        await syncSet({ patterns: next });
    } else {
        const exists = patterns.some(p => canonicalizePattern(p) === canonNew);
        if (!exists) await syncSet({ patterns: [...patterns, newPattern] });
    }

    groupMap[String(groupId)] = newPattern;
    await localSet({ [GROUP_MAP_KEY]: groupMap });
}

function scheduleSave(groupId, title) {
    const prev = saveDebounce.get(groupId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => addOrReplacePatternForGroup(groupId, title), DEBOUNCE_MS);
    saveDebounce.set(groupId, t);
}

chrome.tabGroups.onUpdated.addListener((group) => {
    if (!group || typeof group.id !== 'number') return;
    const title = (group.title || '').trim();
    scheduleSave(group.id, title);
});

// ------------------ Handle removed / ungrouped groups ------------------

async function removePatternForGroupId(groupId) {
    const { [GROUP_MAP_KEY]: groupMap = {} } = await localGet([GROUP_MAP_KEY]);
    const prevPattern = groupMap[String(groupId)];
    delete groupMap[String(groupId)];
    await localSet({ [GROUP_MAP_KEY]: groupMap });

    if (!prevPattern) return;
    const prevCanon = canonicalizePattern(prevPattern);

    const { patterns = [] } = await syncGet(['patterns']);
    const filtered = patterns.filter(p => canonicalizePattern(p) !== prevCanon);
    if (filtered.length !== patterns.length) await syncSet({ patterns: filtered });
}

// Handle when a group is deleted via Chrome UI
chrome.tabGroups.onRemoved.addListener(async (group) => {
    await removePatternForGroupId(group.id);
});

// ------------------ Detect when group becomes empty (all tabs ungrouped) ------------------
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    if (removeInfo.isWindowClosing) return; // will be handled by group removal
    const groupId = removeInfo.groupId;
    if (groupId && groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        const tabs = await chrome.tabs.query({ groupId });
        if (tabs.length === 0) {
            // All tabs ungrouped → remove pattern from popup list
            await removePatternForGroupId(groupId);
        }
    }
});
