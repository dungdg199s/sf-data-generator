// Insert history in the browser (design 0011): whether the server can keep it (no history ⇒ no
// insert, review S7), and the Id download of an insert. The list lives on the server
// (GET /api/history); the client never holds or sends Ids.

import { api } from './api.js';
import { h } from './dom.js';

/** Last GET /api/history: { enabled, reason?, dir, maxRuns, runs, prune } (null until read or when it failed). */
let last = null;

/** The history the server reported last time (null: not read yet, or the server did not answer). */
export const historyStatus = () => last;

/** Reads the history again (status, entries, what the next insert would prune). → the answer or null. */
export async function refreshHistory() {
  try {
    last = await api.history();
  } catch {
    // Server unreachable: keep the last answer; /api/run refuses an insert itself (503) anyway.
  }
  return last;
}

/** Why Insert is locked while history is off (design 0011 §1, the warn-box and the button's title). */
export const historyOffText = (st) => `Không ghi được Lịch sử vào ${st.dir}: ${st.reason}, nên không insert được (app phải ghi được Id để tải lại hay xóa dữ liệu). Đặt biến môi trường SFDG_DATA_DIR tới một thư mục ghi được rồi khởi động lại server.`;

/** "⤓ Id": the CSV of every Id of an insert (sobject,id,ref,step,status); the server names the file. */
export function downloadIds(hid) {
  // No `download` attribute: it would replace the server's file name (Content-Disposition: attachment)
  // with the URL's; an attachment never navigates away from the app.
  const a = h('a', { href: api.idsCsvUrl(hid) });
  document.body.append(a);
  a.click();
  a.remove();
}
