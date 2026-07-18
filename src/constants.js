export const APP_NAME = '懐紙';
export const APP_VERSION = '1.0.0';
export const SCHEMA_VERSION = 1;
export const DB_NAME = 'kaishi-library';
export const DB_VERSION = 1;
export const MEMO_FOLDER_ID = 'folder-memo';
export const MAX_FILE_HISTORIES = 20;
export const MAX_LIBRARY_BACKUPS = 5;
export const TRASH_DAYS = 30;
export const BACKUP_REMINDER_DAYS = 7;

export const COLORS = [
  { id: 'vermilion', label: '朱赤', value: '#E8B7AB' },
  { id: 'pink', label: 'ピンク', value: '#E7C7D1' },
  { id: 'yellow', label: '山吹', value: '#E9D69F' },
  { id: 'blue', label: '青', value: '#BFD5DC' },
  { id: 'gray', label: 'グレー', value: '#D3D1CC' }
];

export const COLOR_MAP = Object.fromEntries(COLORS.map((color) => [color.id, color.value]));

export const DEFAULT_SETTINGS = {
  id: 'appearance',
  fontSize: 17,
  lineHeight: 'standard',
  pageMargin: 'standard',
  fontFamily: 'mincho',
  theme: 'system',
  lastBackupAt: null,
  backupDismissedDate: null,
  changedSinceBackup: false
};

export const DOCUMENT_TYPES = {
  markdown: 'Markdown原稿',
  fumizukue: '文机記法原稿'
};

export const STORE_NAMES = {
  documents: 'documents',
  folders: 'folders',
  stickies: 'stickies',
  histories: 'histories',
  settings: 'settings',
  meta: 'meta',
  backups: 'backups'
};
