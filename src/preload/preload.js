'use strict';

// The renderer's only access to the app: a fixed set of calls and events.

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('leadFinder', {
  listLeads: (filter) => ipcRenderer.invoke('leads:list', filter),
  matchLeads: (filter, ids) => ipcRenderer.invoke('leads:match', filter, ids),
  listDates: (filter) => ipcRenderer.invoke('leads:dates', filter),
  deleteLeads: (ids) => ipcRenderer.invoke('leads:delete', Array.isArray(ids) ? ids : []),
  deleteFiltered: (filter) => ipcRenderer.invoke('leads:deleteFiltered', filter),
  listCategories: () => ipcRenderer.invoke('categories:list'),
  renameCategory: (id, name) => ipcRenderer.invoke('categories:rename', Number(id), String(name ?? '')),
  deleteCategory: (id) => ipcRenderer.invoke('categories:delete', Number(id)),
  // linkedin: LinkedIn's own search (used when LinkedIn Lead Search is on).
  // location: where LinkedIn People search looks (e.g. "USA").
  startSearch: (keyword, category, website, linkedin, location) =>
    ipcRenderer.invoke('search:start', String(keyword ?? ''), String(category ?? ''), String(website ?? 'without'), String(linkedin ?? ''), String(location ?? '')),
  // App lock (4-digit PIN)
  lockState: () => ipcRenderer.invoke('lock:state'),
  lockSetup: (pin, confirm) => ipcRenderer.invoke('lock:setup', String(pin ?? ''), String(confirm ?? '')),
  lockUnlock: (pin) => ipcRenderer.invoke('lock:unlock', String(pin ?? '')),
  lockChange: (current, next, confirm) => ipcRenderer.invoke('lock:change', String(current ?? ''), String(next ?? ''), String(confirm ?? '')),
  lockNow: () => ipcRenderer.invoke('lock:lock'),
  // Subscription: this computer's Activation ID, plan status and activation codes.
  activationStatus: () => ipcRenderer.invoke('activation:status'),
  requestActivation: (plan) => ipcRenderer.invoke('activation:request', String(plan ?? '')),
  verifyActivation: (code, plan) => ipcRenderer.invoke('activation:verify', String(code ?? ''), String(plan ?? '')),
  contactAdmin: (kind, text) => ipcRenderer.invoke('activation:contact', kind === 'call' ? 'call' : 'whatsapp', String(text ?? '')),
  onActivation: (callback) => subscribe('activation:status', callback),
  stopSearch: () => ipcRenderer.invoke('search:stop'),
  // Podcast Lead Finder: a search across the selected platforms; emails are found automatically.
  podcastSettings: () => ipcRenderer.invoke('podcast:settings'),
  setPodcastSettings: (settings) => ipcRenderer.invoke('podcast:setSettings', settings && typeof settings === 'object' ? settings : {}),
  setPodcastKeys: (platform, values) => ipcRenderer.invoke('podcast:setKeys', String(platform ?? ''), values && typeof values === 'object' ? values : {}),
  searchPodcasts: (query, category) => ipcRenderer.invoke('podcast:search', String(query ?? ''), String(category ?? '')),
  stopPodcasts: () => ipcRenderer.invoke('podcast:stop'),
  retryPodcasts: (ids) => ipcRenderer.invoke('podcast:retry', Array.isArray(ids) ? ids.map(Number) : []),
  podcastLeads: (filter) => ipcRenderer.invoke('podcast:leads', filter && typeof filter === 'object' ? filter : {}),
  podcastSearches: () => ipcRenderer.invoke('podcast:searches'),
  podcastIds: (filter) => ipcRenderer.invoke('podcast:ids', filter && typeof filter === 'object' ? filter : {}),
  // { ids: [...] } (the selection) or { all: true }; the app asks before deleting.
  deletePodcasts: (scope) => ipcRenderer.invoke('podcast:delete', scope?.all === true ? { all: true } : { ids: Array.isArray(scope?.ids) ? scope.ids.map(Number) : [] }),
  exportPodcasts: (scope) => ipcRenderer.invoke('podcast:export', scope?.all === true ? { all: true } : { ids: Array.isArray(scope?.ids) ? scope.ids.map(Number) : [] }),
  onPodcastBrowser: (callback) => subscribe('podcast:browser', callback),
  openPodcastLink: (url) => ipcRenderer.invoke('podcast:open', String(url ?? '')),
  onPodcastItem: (callback) => subscribe('podcast:item', callback),
  onPodcastPlatform: (callback) => subscribe('podcast:platform', callback),
  onPodcastStatus: (callback) => subscribe('podcast:status', callback),
  facebookSearch: () => ipcRenderer.invoke('facebook:get'),
  setFacebookSearch: (on) => ipcRenderer.invoke('facebook:set', Boolean(on)),
  mapsSearch: () => ipcRenderer.invoke('maps:get'),
  setMapsSearch: (on) => ipcRenderer.invoke('maps:set', Boolean(on)),
  linkedinSearch: () => ipcRenderer.invoke('linkedin:get'),
  setLinkedInSearch: (on) => ipcRenderer.invoke('linkedin:set', Boolean(on)),
  // LinkedIn modes { jobs, posts, companies }.
  linkedinSettings: () => ipcRenderer.invoke('linkedin:settings'),
  setLinkedInSettings: (settings) => ipcRenderer.invoke('linkedin:setSettings', settings && typeof settings === 'object' ? { modes: settings.modes, contact: settings.contact } : null),
  // Local contact datasets (CSV) for contact discovery.
  importContacts: () => ipcRenderer.invoke('contacts:import'),
  deleteContactDataset: (name) => ipcRenderer.invoke('contacts:deleteDataset', String(name ?? '')),
  // The country local numbers ("0300 1234567") are read with; null = automatic.
  phoneCountry: () => ipcRenderer.invoke('phoneCountry:get'),
  setPhoneCountry: (code) => ipcRenderer.invoke('phoneCountry:set', code === null ? null : String(code ?? '')),
  getStatus: () => ipcRenderer.invoke('search:status'),
  // scope: 'filtered' (leads matching filter) or 'all'
  exportCsv: (scope, filter) => ipcRenderer.invoke('export:csv', scope === 'all' ? 'all' : 'filtered', filter),
  openListing: (url) => ipcRenderer.invoke('lead:open', String(url ?? '')),
  // WhatsApp: linking state, background checks and one-at-a-time sending.
  whatsappState: () => ipcRenderer.invoke('whatsapp:state'),
  whatsappConnect: () => ipcRenderer.invoke('whatsapp:connect'),
  whatsappDisconnect: () => ipcRenderer.invoke('whatsapp:disconnect'),
  whatsappLogout: () => ipcRenderer.invoke('whatsapp:logout'),
  whatsappRecheck: (phone) => ipcRenderer.invoke('whatsapp:recheck', String(phone ?? '')),
  whatsappSend: (leadId, text) => ipcRenderer.invoke('whatsapp:send', Number(leadId), String(text ?? '')),
  whatsappLastMessage: (leadId) => ipcRenderer.invoke('whatsapp:lastMessage', Number(leadId)),
  onWhatsAppState: (cb) => subscribe('whatsapp:state', cb),
  onWhatsAppLeads: (cb) => subscribe('leads:whatsapp', cb),
  getInterrupted: () => ipcRenderer.invoke('search:interrupted'),
  dismissInterrupted: () => ipcRenderer.invoke('search:dismissInterrupted'),
  onStatus: (cb) => subscribe('search:status', cb),
  onLead: (cb) => subscribe('leads:added', cb),
  onSummary: (cb) => subscribe('search:summary', cb),
  // Real-estate outreach campaigns
  outreachOverview: () => ipcRenderer.invoke('outreach:overview'),
  outreachCategoryCampaign: (category) => ipcRenderer.invoke('outreach:categoryCampaign', String(category ?? '')),
  outreachSetCategory: (category, on, acknowledge) => ipcRenderer.invoke('outreach:setCategory', String(category ?? ''), on === true, { acknowledge: acknowledge === true }),
  outreachCreate: (name) => ipcRenderer.invoke('outreach:create', String(name ?? '')),
  outreachDelete: (ids) => ipcRenderer.invoke('outreach:delete', Array.isArray(ids) ? ids.map(Number) : []),
  outreachReset: (ids) => ipcRenderer.invoke('outreach:reset', Array.isArray(ids) ? ids.map(Number) : []),
  outreachState: (id) => ipcRenderer.invoke('outreach:state', Number(id)),
  outreachEligible: (id, filters) => ipcRenderer.invoke('outreach:eligible', Number(id), filters && typeof filters === 'object' ? JSON.parse(JSON.stringify(filters)) : {}),
  outreachHistory: () => ipcRenderer.invoke('outreach:history'),
  outreachConfigure: (id, cfg) => ipcRenderer.invoke('outreach:configure', Number(id), cfg && typeof cfg === 'object' ? JSON.parse(JSON.stringify(cfg)) : null),
  outreachAddLeads: (id, ids) => ipcRenderer.invoke('outreach:addLeads', Number(id), Array.isArray(ids) ? ids.map(Number) : []),
  outreachStart: (id, acknowledge) => ipcRenderer.invoke('outreach:start', Number(id), { acknowledge: acknowledge === true }),
  outreachPause: (id) => ipcRenderer.invoke('outreach:pause', Number(id)),
  outreachResume: (id) => ipcRenderer.invoke('outreach:resume', Number(id)),
  outreachStop: (id) => ipcRenderer.invoke('outreach:stop', Number(id)),
  outreachExclude: (id, phone) => ipcRenderer.invoke('outreach:exclude', Number(id), String(phone ?? '')),
  outreachInclude: (id, phone) => ipcRenderer.invoke('outreach:include', Number(id), String(phone ?? '')),
  outreachRemoveContact: (id, phone) => ipcRenderer.invoke('outreach:removeContact', Number(id), String(phone ?? '')),
  outreachOptOut: (phone) => ipcRenderer.invoke('outreach:optOut', String(phone ?? '')),
  outreachSetName: (id, phone, name) => ipcRenderer.invoke('outreach:setName', Number(id), String(phone ?? ''), name == null ? null : String(name)),
  outreachRender: (id, templates, phone) => ipcRenderer.invoke('outreach:render', Number(id), Array.isArray(templates) ? templates.map((t) => ({ text: String(t?.text ?? ''), fallback: String(t?.fallback ?? '') })) : [], String(phone ?? '')),
  onOutreach: (cb) => subscribe('outreach:state', cb),
  onOutreachEvent: (cb) => subscribe('outreach:event', cb),
  // Automatic updates
  updateStatus: () => ipcRenderer.invoke('update:status'),
  openUpdateDownload: () => ipcRenderer.invoke('update:openDownload'),
  onUpdate: (cb) => subscribe('update:status', cb),
  // Dialer: real calls on the user's phone over Bluetooth Hands-Free, audio on this computer.
  dialerState: () => ipcRenderer.invoke('dialer:state'),
  onDialerState: (callback) => subscribe('dialer:state', callback),
  onDialerIncoming: (callback) => subscribe('dialer:incoming', callback),
  onDialerHistory: (callback) => subscribe('dialer:history', callback),
  dialerScan: (on) => ipcRenderer.invoke('dialer:scan', Boolean(on)),
  dialerVisible: (on) => ipcRenderer.invoke('dialer:visible', Boolean(on)),
  dialerPower: (on) => ipcRenderer.invoke('dialer:power', Boolean(on)),
  dialerConnect: (address) => ipcRenderer.invoke('dialer:connect', String(address ?? '')),
  dialerConfirmPairing: (accept) => ipcRenderer.invoke('dialer:confirmPairing', Boolean(accept)),
  dialerDisconnect: () => ipcRenderer.invoke('dialer:disconnect'),
  dialerReconnect: () => ipcRenderer.invoke('dialer:reconnect'),
  dialerForget: (address) => ipcRenderer.invoke('dialer:forget', String(address ?? '')),
  dialerCall: (number, opts) => ipcRenderer.invoke('dialer:call', String(number ?? ''), { leadId: Number(opts?.leadId) || null }),
  dialerHangup: () => ipcRenderer.invoke('dialer:hangup'),
  dialerAnswer: () => ipcRenderer.invoke('dialer:answer'),
  dialerReject: () => ipcRenderer.invoke('dialer:reject'),
  dialerMute: (on) => ipcRenderer.invoke('dialer:mute', Boolean(on)),
  dialerRefreshSim: () => ipcRenderer.invoke('dialer:refreshSim'),
  // Auto Dialer: calls Call Unseen leads one after another while it is on.
  autoDialState: () => ipcRenderer.invoke('autodial:state'),
  onAutoDialState: (callback) => subscribe('autodial:state', callback),
  autoDialStart: () => ipcRenderer.invoke('autodial:start'),
  autoDialPause: () => ipcRenderer.invoke('autodial:pause'),
  autoDialResume: () => ipcRenderer.invoke('autodial:resume'),
  autoDialStop: () => ipcRenderer.invoke('autodial:stop'),
  autoDialSettings: (s) => ipcRenderer.invoke('autodial:settings', s && typeof s === 'object' ? { gapSeconds: s.gapSeconds, ringSeconds: s.ringSeconds, mobileOnly: s.mobileOnly, hours: s.hours && typeof s.hours === 'object' ? { on: s.hours.on, from: s.hours.from, to: s.hours.to } : undefined } : {}),
  setDoNotCall: (id, on) => ipcRenderer.invoke('leads:doNotCall', Number(id), Boolean(on)),
  onCallLeads: (callback) => subscribe('leads:call', callback),
  dialerTakeHandsFree: () => ipcRenderer.invoke('dialer:takeHandsFree'),
  dialerDtmf: (key) => ipcRenderer.invoke('dialer:dtmf', String(key ?? '')),
  dialerAudioTo: (where) => ipcRenderer.invoke('dialer:audioTo', where === 'phone' ? 'phone' : 'computer'),
  dialerSetAudio: (prefs) => ipcRenderer.invoke('dialer:setAudio', prefs && typeof prefs === 'object' ? { output: prefs.output, input: prefs.input, echoCancel: prefs.echoCancel } : {}),
  dialerHistory: (filter) => ipcRenderer.invoke('dialer:history', filter && typeof filter === 'object' ? { search: filter.search, direction: filter.direction, status: filter.status, leadId: filter.leadId, limit: filter.limit } : {}),
});
