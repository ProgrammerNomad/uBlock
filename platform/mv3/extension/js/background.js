/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2022-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* jshint esversion:11 */

'use strict';

/******************************************************************************/

import {
    browser,
    dnr,
    runtime,
    localRead, localWrite,
    sessionRead, sessionWrite,
} from './ext.js';

import {
    CURRENT_CONFIG_BASE_RULE_ID,
    getRulesetDetails,
    getDynamicRules,
    defaultRulesetsFromLanguage,
    enableRulesets,
    getEnabledRulesetsDetails,
    updateDynamicRules,
} from './ruleset-manager.js';

import {
    registerInjectables,
} from './scripting-manager.js';

import {
    getFilteringMode,
    setFilteringMode,
    getDefaultFilteringMode,
    setDefaultFilteringMode,
    syncWithBrowserPermissions,
} from './mode-manager.js';

import {
    ubolLog,
} from './utils.js';

/******************************************************************************/

const rulesetConfig = {
    version: '',
    enabledRulesets: [ 'default' ],
    autoReload: 1,
    firstRun: false,
};

const UBOL_ORIGIN = runtime.getURL('').replace(/\/$/, '');

/******************************************************************************/

function getCurrentVersion() {
    return runtime.getManifest().version;
}

async function loadRulesetConfig() {
    let data = await sessionRead('rulesetConfig');
    if ( data ) {
        rulesetConfig.version = data.version;
        rulesetConfig.enabledRulesets = data.enabledRulesets;
        rulesetConfig.autoReload = data.autoReload;
        return;
    }
    data = await localRead('rulesetConfig');
    if ( data ) {
        rulesetConfig.version = data.version;
        rulesetConfig.enabledRulesets = data.enabledRulesets;
        rulesetConfig.autoReload = data.autoReload;
        return;
    }
    data = await loadRulesetConfig.convertLegacyStorage();
    if ( data ) {
        rulesetConfig.version = data.version;
        rulesetConfig.enabledRulesets = data.enabledRulesets;
        rulesetConfig.autoReload = data.autoReload;
        return;
    }
    rulesetConfig.enabledRulesets = await defaultRulesetsFromLanguage();
    rulesetConfig.firstRun = true;
    sessionWrite('rulesetConfig', rulesetConfig);
    localWrite('rulesetConfig', rulesetConfig);
}

// TODO: To remove after next stable release is widespread (2023-06-04)
loadRulesetConfig.convertLegacyStorage = async function() {
    const dynamicRuleMap = await getDynamicRules();
    const configRule = dynamicRuleMap.get(CURRENT_CONFIG_BASE_RULE_ID);
    if ( configRule === undefined ) { return; }
    let rawConfig;
    try {
        rawConfig = JSON.parse(self.atob(configRule.condition.urlFilter));
    } catch(ex) {
        return;
    }
    if ( rawConfig === undefined ) { return; }
    const config = {
        version: rawConfig[0],
        enabledRulesets: rawConfig[1],
        autoReload: rawConfig[2],
    };
    localWrite('rulesetConfig', config);
    sessionWrite('rulesetConfig', config);
    dnr.updateDynamicRules({
        removeRuleIds: [ CURRENT_CONFIG_BASE_RULE_ID ],
    });
    return config;
};

async function saveRulesetConfig() {
    sessionWrite('rulesetConfig', rulesetConfig);
    return localWrite('rulesetConfig', rulesetConfig);
}

/******************************************************************************/

async function hasGreatPowers(origin) {
    if ( /^https?:\/\//.test(origin) === false ) { return false; }
    return browser.permissions.contains({
        origins: [ `${origin}/*` ],
    });
}

function hasOmnipotence() {
    return browser.permissions.contains({
        origins: [ '<all_urls>' ],
    });
}

async function onPermissionsRemoved() {
    const beforeMode = await getDefaultFilteringMode();
    const modified = await syncWithBrowserPermissions();
    if ( modified === false ) { return; }
    const afterMode = await getDefaultFilteringMode();
    if ( beforeMode > 1 && afterMode <= 1 ) {
        updateDynamicRules();
    }
    registerInjectables();
}

/******************************************************************************/

function onMessage(request, sender, callback) {

    // Does not require trusted origin.

    switch ( request.what ) {

    case 'insertCSS': {
        const tabId = sender?.tab?.id ?? false;
        const frameId = sender?.frameId ?? false;
        if ( tabId === false || frameId === false ) { return; }
        browser.scripting.insertCSS({
            css: request.css,
            origin: 'USER',
            target: { tabId, frameIds: [ frameId ] },
        }).catch(reason => {
            console.log(reason);
        });
        return;
    }

    default:
        break;
    }

    // Does requires trusted origin.

    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/MessageSender
    //   Firefox API does not set `sender.origin`
    if ( sender.origin !== undefined && sender.origin !== UBOL_ORIGIN ) { return; }

    switch ( request.what ) {

    case 'applyRulesets': {
        enableRulesets(request.enabledRulesets).then(( ) => {
            rulesetConfig.enabledRulesets = request.enabledRulesets;
            return saveRulesetConfig();
        }).then(( ) => {
            registerInjectables();
            callback();
        });
        return true;
    }

    case 'getOptionsPageData': {
        Promise.all([
            getDefaultFilteringMode(),
            getRulesetDetails(),
            dnr.getEnabledRulesets(),
        ]).then(results => {
            const [
                defaultFilteringMode,
                rulesetDetails,
                enabledRulesets,
            ] = results;
            callback({
                defaultFilteringMode,
                enabledRulesets,
                rulesetDetails: Array.from(rulesetDetails.values()),
                autoReload: rulesetConfig.autoReload === 1,
                firstRun: rulesetConfig.firstRun,
            });
            rulesetConfig.firstRun = false;
        });
        return true;
    }

    case 'setAutoReload':
        rulesetConfig.autoReload = request.state ? 1 : 0;
        saveRulesetConfig().then(( ) => {
            callback();
        });
        return true;

    case 'popupPanelData': {
        Promise.all([
            getFilteringMode(request.hostname),
            hasOmnipotence(),
            hasGreatPowers(request.origin),
            getEnabledRulesetsDetails(),
        ]).then(results => {
            callback({
                level: results[0],
                autoReload: rulesetConfig.autoReload === 1,
                hasOmnipotence: results[1],
                hasGreatPowers: results[2],
                rulesetDetails: results[3],
            });
        });
        return true;
    }

    case 'getFilteringMode': {
        getFilteringMode(request.hostname).then(actualLevel => {
            callback(actualLevel);
        });
        return true;
    }

    case 'setFilteringMode': {
        getFilteringMode(request.hostname).then(actualLevel => {
            if ( request.level === actualLevel ) { return actualLevel; }
            return setFilteringMode(request.hostname, request.level);
        }).then(actualLevel => {
            registerInjectables();
            callback(actualLevel);
        });
        return true;
    }

    case 'setDefaultFilteringMode': {
        getDefaultFilteringMode(
        ).then(beforeLevel =>
            setDefaultFilteringMode(request.level).then(afterLevel =>
                ({ beforeLevel, afterLevel })
            )
        ).then(({ beforeLevel, afterLevel }) => {
            if ( beforeLevel === 1 || afterLevel === 1 ) {
                updateDynamicRules();
            }
            if ( afterLevel !== beforeLevel ) {
                registerInjectables();
            }
            callback(afterLevel);
        });
        return true;
    }

    default:
        break;
    }
}

/******************************************************************************/

async function start() {
    await loadRulesetConfig();
    await enableRulesets(rulesetConfig.enabledRulesets);

    // We need to update the regex rules only when ruleset version changes.
    const currentVersion = getCurrentVersion();
    if ( currentVersion !== rulesetConfig.version ) {
        ubolLog(`Version change: ${rulesetConfig.version} => ${currentVersion}`);
        updateDynamicRules().then(( ) => {
            rulesetConfig.version = currentVersion;
            saveRulesetConfig();
        });
    }

    // Permissions may have been removed while the extension was disabled
    await onPermissionsRemoved();

    // Unsure whether the browser remembers correctly registered css/scripts
    // after we quit the browser. For now uBOL will check unconditionally at
    // launch time whether content css/scripts are properly registered.
    registerInjectables();

    const enabledRulesets = await dnr.getEnabledRulesets();
    ubolLog(`Enabled rulesets: ${enabledRulesets}`);

    dnr.getAvailableStaticRuleCount().then(count => {
        ubolLog(`Available static rule count: ${count}`);
    });

    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest
    //   Firefox API does not support `dnr.setExtensionActionOptions`
    if ( dnr.setExtensionActionOptions ) {
        dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
    }
}

(async ( ) => {
    await start();

    runtime.onMessage.addListener(onMessage);

    browser.permissions.onRemoved.addListener(
        ( ) => { onPermissionsRemoved(); }
    );

    if ( rulesetConfig.firstRun ) {
        runtime.openOptionsPage();
    }
})();
