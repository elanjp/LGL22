/**
 * Gmail 重複メール検出・ゴミ箱移動スクリプト
 *
 * 「同じ日」「同じ件名」「同じ本文」「同じ送信者」から届いたメールを重複とみなし、
 * 最も古い1通だけを残して残りをゴミ箱へ移動する。
 */

const CONFIG = {
  // 何日前までのメールを検索対象にするか
  LOOKBACK_DAYS: 7,
  // 検索対象を絞りたい場合はここを編集する（例: 'in:inbox -in:chats -label:重要'）
  SEARCH_QUERY: 'in:inbox',
  // true にすると実際には削除せず、判定結果のログ出力のみ行う
  DRY_RUN: false,
  // 同一送信者からのメールのみ重複とみなすか
  REQUIRE_SAME_SENDER: true,
  // 実行結果を通知したい場合はメールアドレスを指定（空文字なら通知しない）
  NOTIFY_EMAIL: '',
  // GmailApp.search の1回あたりの取得件数
  PAGE_SIZE: 100,
  // 安全のためのスレッド取得上限
  MAX_THREADS: 2000,
};

function findAndTrashDuplicateEmails() {
  const query = `${CONFIG.SEARCH_QUERY} newer_than:${CONFIG.LOOKBACK_DAYS}d`;
  const threads = searchAllThreads(query);

  const groups = new Map(); // key -> [{ message, thread }]
  threads.forEach((thread) => {
    thread.getMessages().forEach((message) => {
      const key = buildDedupeKey(message);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ message, thread });
    });
  });

  const trashed = [];
  const skipped = [];

  groups.forEach((entries) => {
    if (entries.length < 2) return; // 重複なし

    // 到着順（古い順）にソートし、先頭の1通だけ残す
    entries.sort((a, b) => a.message.getDate() - b.message.getDate());
    const duplicates = entries.slice(1);

    duplicates.forEach(({ message, thread }) => {
      const info = describeMessage(message);

      // 重複メッセージが他の非重複メッセージと同じスレッドに属する場合、
      // スレッドごと削除すると巻き添えが出るためスキップし手動確認に回す
      if (thread.getMessageCount() > 1) {
        skipped.push(`${info}（スレッド内に他のメッセージあり: 手動確認要）`);
        return;
      }

      if (CONFIG.DRY_RUN) {
        trashed.push(`[DRY RUN] ${info}`);
      } else {
        message.moveToTrash();
        trashed.push(info);
      }
    });
  });

  logAndNotify(trashed, skipped);
}

function searchAllThreads(query) {
  const all = [];
  let start = 0;
  while (start < CONFIG.MAX_THREADS) {
    const page = GmailApp.search(query, start, CONFIG.PAGE_SIZE);
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < CONFIG.PAGE_SIZE) break;
    start += CONFIG.PAGE_SIZE;
  }
  return all;
}

function buildDedupeKey(message) {
  const day = Utilities.formatDate(
    message.getDate(),
    Session.getScriptTimeZone(),
    'yyyy-MM-dd'
  );
  const subject = normalizeSubject(message.getSubject());
  const bodyHash = hashText(message.getPlainBody());
  const parts = [day, subject, bodyHash];
  if (CONFIG.REQUIRE_SAME_SENDER) {
    parts.push(message.getFrom());
  }
  return parts.join('||');
}

function normalizeSubject(subject) {
  return (subject || '')
    .trim()
    .toLowerCase()
    .replace(/^(re|fwd?):\s*/i, '')
    .replace(/\s+/g, ' ');
}

function hashText(text) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text || '');
  return digest.map((b) => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

function describeMessage(message) {
  return `${message.getDate().toISOString()} | ${message.getFrom()} | ${message.getSubject()}`;
}

function logAndNotify(trashed, skipped) {
  Logger.log('=== ゴミ箱へ移動したメール (%s件) ===', trashed.length);
  trashed.forEach((line) => Logger.log(line));
  Logger.log('=== 手動確認が必要なメール (%s件) ===', skipped.length);
  skipped.forEach((line) => Logger.log(line));

  if (CONFIG.NOTIFY_EMAIL && (trashed.length || skipped.length)) {
    const body = [
      `重複メール検出結果 (${new Date().toLocaleString()})`,
      '',
      `ゴミ箱へ移動: ${trashed.length} 件`,
      ...trashed,
      '',
      `手動確認が必要: ${skipped.length} 件`,
      ...skipped,
    ].join('\n');
    GmailApp.sendEmail(CONFIG.NOTIFY_EMAIL, '[Gmail重複検出] 実行結果', body);
  }
}

/**
 * 毎日決まった時刻に findAndTrashDuplicateEmails を実行するトリガーを設置する。
 * 既存の同名トリガーは削除してから作り直すため、複数回実行しても重複しない。
 */
function createDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'findAndTrashDuplicateEmails')
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('findAndTrashDuplicateEmails')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
}
