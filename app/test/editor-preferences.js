/* global calls, command, fixture -- provided by the editor test harness */
assert(!document.querySelector('#preferences, #preferences-btn, #empty-preferences'), 'document UI has no Preferences dialog or buttons');
await command('preferences');
assert(calls.command === 'preferences', 'Settings command goes to the main process');
await window.simplemd.setSettings({ theme: 'light', themeLight: 'solarized-light', readingFontFamily: 'Georgia', readingFontSize: 20 });
assert(getComputedStyle(document.querySelector('#stage')).backgroundColor === 'rgb(253, 246, 227)', 'document uses the chosen palette');
assert(getComputedStyle(document.querySelector('#doc')).fontSize === '20px', 'reading typography updates live');
await window.simplemd.setSettings({ readingStyle: 'github' });
assert(getComputedStyle(document.querySelector('#doc')).fontSize === '16px', 'GitHub style uses 16px');
await fixture.screenshot('document-theme');
