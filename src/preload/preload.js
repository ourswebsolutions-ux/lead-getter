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
  listDates: (filter) => ipcRenderer.invoke('leads:dates', filter),
  deleteLeads: (ids) => ipcRenderer.invoke('leads:delete', Array.isArray(ids) ? ids : []),
  deleteFiltered: (filter) => ipcRenderer.invoke('leads:deleteFiltered', filter),
  listCategories: () => ipcRenderer.invoke('categories:list'),
  renameCategory: (id, name) => ipcRenderer.invoke('categories:rename', Number(id), String(name ?? '')),
  deleteCategory: (id) => ipcRenderer.invoke('categories:delete', Number(id)),
  startSearch: (keyword, category) => ipcRenderer.invoke('search:start', String(keyword ?? ''), String(category ?? '')),
  stopSearch: () => ipcRenderer.invoke('search:stop'),
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
});
