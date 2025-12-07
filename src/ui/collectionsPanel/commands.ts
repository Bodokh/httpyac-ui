/**
 * Command identifiers for the collections panel
 */
export const commands = {
  openRequest: 'httpyac.ui.openRequest',
  newRequest: 'httpyac.ui.newRequest',
  newCollection: 'httpyac.ui.newCollection',
  deleteItem: 'httpyac.ui.deleteItem',
  renameItem: 'httpyac.ui.renameItem',
  duplicateRequest: 'httpyac.ui.duplicateRequest',
  refreshCollections: 'httpyac.ui.refreshCollections',
  sendRequest: 'httpyac.ui.sendRequest',
  openInEditor: 'httpyac.ui.openInEditor',
  importCollection: 'httpyac.ui.importCollection',
  exportCollection: 'httpyac.ui.exportCollection',
} as const;

export type CommandId = (typeof commands)[keyof typeof commands];

