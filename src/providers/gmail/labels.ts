/**
 * The ONE registry of neutral-folder ↔ Gmail-label semantics. The neutral
 * folder names (`inbox`, `sentitems`, …) are the wire contract shared with
 * hadrontool-ms-exchange; Gmail label ids never cross the ops boundary
 * except as opaque folder ids the caller got from list-folders.
 */

/** Neutral folder name → Gmail system label id. */
export const FOLDER_TO_LABEL: Record<string, string> = {
  inbox: 'INBOX',
  sentitems: 'SENT',
  drafts: 'DRAFT',
  junkemail: 'SPAM',
  deleteditems: 'TRASH',
};

/**
 * Resolve a folder argument to a Gmail label id: neutral names map through
 * the registry (case-insensitive); anything else is treated as a raw label
 * id the caller obtained from list-folders.
 */
export function labelForFolder(folder: string): string {
  return FOLDER_TO_LABEL[folder.toLowerCase()] ?? folder;
}

/** Message read state lives in the UNREAD label. */
export const UNREAD_LABEL = 'UNREAD';

/** The neutral `flagged` state lives in the STARRED label. */
export const STARRED_LABEL = 'STARRED';
