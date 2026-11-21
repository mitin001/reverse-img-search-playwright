import { fullCropUrl } from './rewrite.js';

chrome.action.onClicked.addListener((tab) => {
  const href = tab.url && fullCropUrl(tab.url);
  if (href) return chrome.tabs.update(tab.id, { url: href });
  // Not a Lens result, or Google changed the vsint layout.
  chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
  setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 2000);
});
