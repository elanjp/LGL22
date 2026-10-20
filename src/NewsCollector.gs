/**
 * ニュース収集・整理スクリプト
 *
 * スプレッドシートの「対象」シートで選んだカテゴリ × 言語 × 検索クエリごとに
 * Google News の RSS からニュースを集め、重複を除いて「記事」シートへ蓄積し、
 * カテゴリ・言語別に整理したダイジェストをメールで送る。
 *
 * 同じプロジェクト内の Code.gs とグローバル名が衝突しないよう、
 * 設定は NEWS_CONFIG、内部関数は末尾に _ を付けた名前にしている。
 */

const NEWS_CONFIG = {
  // 保存先スプレッドシートの ID。空なら setupNewsCollector() が新規作成して保存する
  SPREADSHEET_ID: '',
  // ダイジェストの送信先。空なら実行ユーザー自身に送る
  NOTIFY_EMAIL: '',
  // 何時間前までに公開された記事を対象にするか（1日2回実行なので重複分は除外される）
  LOOKBACK_HOURS: 24,
  // 1クエリあたりの最大取得件数
  MAX_ITEMS_PER_QUERY: 20,
  // メール内で1グループ（カテゴリ×言語）あたりに載せる最大件数（シートには全件残る）
  MAX_ITEMS_PER_GROUP_IN_MAIL: 10,
  // 日本語以外のタイトルを日本語訳するか（LanguageApp の1日の上限に注意）
  TRANSLATE_TITLES: true,
  // 重複判定のために参照する「記事」シートの直近行数
  DEDUPE_LOOKBACK_ROWS: 5000,
  // 実行時刻（Asia/Tokyo）。createNewsTriggers() がこの時刻にトリガーを設置する
  RUN_HOURS: [7, 18],
  // 新着が0件でもメールを送るか
  SEND_EMPTY_DIGEST: false,
};

// 言語コード -> Google News のエディション
const NEWS_EDITIONS = {
  ja: { label: '日本語', hl: 'ja', gl: 'JP', ceid: 'JP:ja' },
  en: { label: '英語', hl: 'en-US', gl: 'US', ceid: 'US:en' },
  zh: { label: '中国語(簡体)', hl: 'zh-CN', gl: 'CN', ceid: 'CN:zh-Hans' },
  'zh-TW': { label: '中国語(繁体)', hl: 'zh-TW', gl: 'TW', ceid: 'TW:zh-Hant' },
  ko: { label: '韓国語', hl: 'ko', gl: 'KR', ceid: 'KR:ko' },
  ru: { label: 'ロシア語', hl: 'ru', gl: 'RU', ceid: 'RU:ru' },
};

// 「対象」シートの初期値: [有効, カテゴリ, 言語, 検索クエリ]
const NEWS_DEFAULT_TARGETS = [
  [true, '政治', 'ja', '政治 OR 首相 OR 国会 OR 内閣 OR 選挙'],
  [true, '政治', 'en', 'politics OR election OR parliament OR "prime minister" OR president'],
  [true, '政治', 'zh', '政治 OR 选举 OR 总统 OR 总理 OR 议会'],
  [true, '政治', 'ko', '정치 OR 대통령 OR 국회 OR 선거'],
  [true, '政治', 'ru', 'политика OR выборы OR президент OR парламент'],
  [true, '国際情勢', 'ja', '外交 OR 国際情勢 OR 首脳会談 OR 制裁 OR 国連'],
  [true, '国際情勢', 'en', 'diplomacy OR geopolitics OR sanctions OR summit OR "United Nations"'],
  [true, '国際情勢', 'zh', '外交 OR 国际局势 OR 制裁 OR 峰会 OR 联合国'],
  [true, '国際情勢', 'ko', '외교 OR 국제정세 OR 제재 OR 정상회담 OR 유엔'],
  [true, '国際情勢', 'ru', 'дипломатия OR геополитика OR санкции OR саммит OR ООН'],
  [true, '軍事', 'ja', '軍事 OR 防衛省 OR 自衛隊 OR ミサイル OR 安全保障'],
  [true, '軍事', 'en', 'military OR defense OR missile OR NATO OR Pentagon'],
  [true, '軍事', 'zh', '军事 OR 国防 OR 解放军 OR 导弹 OR 军演'],
  [true, '軍事', 'ko', '군사 OR 국방 OR 미사일 OR 합참 OR 안보'],
  [true, '軍事', 'ru', 'военные OR армия OR Минобороны OR ракета OR НАТО'],
];

const NEWS_TARGET_SHEET = '対象';
const NEWS_ARTICLE_SHEET = '記事';
const NEWS_ARTICLE_HEADER = [
  '取得日時', '公開日時', 'カテゴリ', '言語', 'タイトル', 'タイトル(日本語訳)', '媒体', 'URL', '重複キー',
];
const NEWS_KEY_COLUMN = NEWS_ARTICLE_HEADER.indexOf('重複キー') + 1;

/**
 * 初回に一度だけ手動実行する。スプレッドシートと「対象」「記事」シートを用意する。
 */
function setupNewsCollector() {
  const ss = openNewsSpreadsheet_();
  getTargetSheet_(ss);
  getArticleSheet_(ss);
  Logger.log('スプレッドシート: %s', ss.getUrl());
}

/**
 * メイン処理。トリガーから1日2回呼ばれる。
 */
function collectNews() {
  const ss = openNewsSpreadsheet_();
  const targets = readTargets_(getTargetSheet_(ss));
  const articleSheet = getArticleSheet_(ss);

  const fetched = fetchArticles_(targets);
  const seenKeys = readSeenKeys_(articleSheet);
  const cutoff = Date.now() - NEWS_CONFIG.LOOKBACK_HOURS * 3600 * 1000;

  const fresh = [];
  fetched.forEach((article) => {
    if (article.published.getTime() < cutoff) return;
    if (seenKeys.has(article.key)) return;
    seenKeys.add(article.key);
    fresh.push(article);
  });

  if (NEWS_CONFIG.TRANSLATE_TITLES) translateTitles_(fresh);

  fresh.sort((a, b) => b.published - a.published);
  appendArticles_(articleSheet, fresh);
  Logger.log('取得 %s 件 / 新着 %s 件', fetched.length, fresh.length);

  if (fresh.length || NEWS_CONFIG.SEND_EMPTY_DIGEST) {
    sendDigest_(fresh, targets, ss.getUrl());
  }
}

function openNewsSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = NEWS_CONFIG.SPREADSHEET_ID || props.getProperty('NEWS_SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);

  const ss = SpreadsheetApp.create('ニュースまとめ');
  props.setProperty('NEWS_SPREADSHEET_ID', ss.getId());
  // 新規作成時の空の「シート1」は対象シートとして使い回す
  ss.getSheets()[0].setName(NEWS_TARGET_SHEET);
  return ss;
}

function getTargetSheet_(ss) {
  let sheet = ss.getSheetByName(NEWS_TARGET_SHEET);
  if (!sheet) sheet = ss.insertSheet(NEWS_TARGET_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['有効', 'カテゴリ', '言語', '検索クエリ']);
    sheet.getRange(2, 1, NEWS_DEFAULT_TARGETS.length, 4).setValues(NEWS_DEFAULT_TARGETS);
    sheet.getRange(2, 1, NEWS_DEFAULT_TARGETS.length, 1).insertCheckboxes();
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    sheet.setColumnWidth(4, 520);
    sheet.getRange(1, 6).setValue(
      `言語コード: ${Object.keys(NEWS_EDITIONS).join(', ')} / 検索クエリは Google ニュースの検索構文（OR, "完全一致", -除外）が使えます`
    );
  }
  return sheet;
}

function getArticleSheet_(ss) {
  let sheet = ss.getSheetByName(NEWS_ARTICLE_SHEET);
  if (!sheet) sheet = ss.insertSheet(NEWS_ARTICLE_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(NEWS_ARTICLE_HEADER);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, NEWS_ARTICLE_HEADER.length).setFontWeight('bold');
    sheet.hideColumns(NEWS_KEY_COLUMN);
  }
  return sheet;
}

function readTargets_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet
    .getRange(2, 1, last - 1, 4)
    .getValues()
    .filter(([enabled, category, lang, query]) => enabled === true && category && query)
    .map(([, category, lang, query]) => ({
      category: String(category).trim(),
      lang: String(lang).trim(),
      query: String(query).trim(),
    }))
    .filter((t) => {
      if (NEWS_EDITIONS[t.lang]) return true;
      Logger.log('未対応の言語コードのためスキップ: %s (%s)', t.lang, t.category);
      return false;
    });
}

function fetchArticles_(targets) {
  const requests = targets.map((t) => {
    const ed = NEWS_EDITIONS[t.lang];
    const q = encodeURIComponent(`${t.query} when:1d`);
    return {
      url: `https://news.google.com/rss/search?q=${q}&hl=${ed.hl}&gl=${ed.gl}&ceid=${ed.ceid}`,
      muteHttpExceptions: true,
    };
  });
  const responses = UrlFetchApp.fetchAll(requests);

  const articles = [];
  responses.forEach((res, i) => {
    const target = targets[i];
    if (res.getResponseCode() !== 200) {
      Logger.log('取得失敗 %s: %s %s', res.getResponseCode(), target.category, target.lang);
      return;
    }
    try {
      parseRss_(res.getContentText()).slice(0, NEWS_CONFIG.MAX_ITEMS_PER_QUERY).forEach((item) => {
        articles.push(Object.assign(item, { category: target.category, lang: target.lang }));
      });
    } catch (e) {
      Logger.log('RSS 解析失敗 %s %s: %s', target.category, target.lang, e);
    }
  });
  return articles;
}

function parseRss_(xml) {
  const channel = XmlService.parse(xml).getRootElement().getChild('channel');
  return channel.getChildren('item').map((item) => {
    const sourceEl = item.getChild('source');
    const source = sourceEl ? sourceEl.getText() : '';
    // Google News のタイトルは「見出し - 媒体名」形式なので媒体名を取り除く
    let title = item.getChildText('title') || '';
    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3));
    }
    return {
      title: title.trim(),
      titleJa: '',
      source,
      url: item.getChildText('link') || '',
      published: new Date(item.getChildText('pubDate')),
      key: newsHash_(normalizeTitle_(title)),
    };
  });
}

function normalizeTitle_(title) {
  return title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function newsHash_(text) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8);
  return digest.map((b) => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

function readSeenKeys_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return new Set();
  const rows = Math.min(last - 1, NEWS_CONFIG.DEDUPE_LOOKBACK_ROWS);
  const values = sheet.getRange(last - rows + 1, NEWS_KEY_COLUMN, rows, 1).getValues();
  return new Set(values.map(([key]) => key));
}

/**
 * 日本語以外のタイトルを言語ごとにまとめて翻訳する（改行区切りで1回の呼び出しにし、
 * LanguageApp の呼び出し回数を節約する）。行数がずれた場合は1件ずつ翻訳し直す。
 */
function translateTitles_(articles) {
  const byLang = new Map();
  articles.forEach((a) => {
    if (a.lang === 'ja') return;
    if (!byLang.has(a.lang)) byLang.set(a.lang, []);
    byLang.get(a.lang).push(a);
  });

  byLang.forEach((list, lang) => {
    try {
      // 翻訳元言語は自動判定に任せる
      const lines = LanguageApp.translate(list.map((a) => a.title).join('\n'), '', 'ja').split('\n');
      if (lines.length === list.length) {
        list.forEach((a, i) => (a.titleJa = lines[i].trim()));
        return;
      }
      list.forEach((a) => (a.titleJa = LanguageApp.translate(a.title, '', 'ja')));
    } catch (e) {
      Logger.log('翻訳失敗 (%s): %s', lang, e);
    }
  });
}

function appendArticles_(sheet, articles) {
  if (!articles.length) return;
  const now = new Date();
  const rows = articles.map((a) => [
    now, a.published, a.category, NEWS_EDITIONS[a.lang].label, a.title, a.titleJa, a.source, a.url, a.key,
  ]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, NEWS_ARTICLE_HEADER.length).setValues(rows);
}

function sendDigest_(articles, targets, sheetUrl) {
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const slot = Number(Utilities.formatDate(now, tz, 'H')) < 12 ? '朝' : '夕';
  const subject = `[ニュースまとめ] ${Utilities.formatDate(now, tz, 'yyyy-MM-dd')} ${slot} (${articles.length}件)`;

  // 「対象」シートの並び順でカテゴリ・言語を並べる
  const categories = [...new Set(targets.map((t) => t.category))];
  const langs = [...new Set(targets.map((t) => t.lang))];

  const html = [`<p>新着 ${articles.length} 件 / <a href="${sheetUrl}">全件はスプレッドシート</a></p>`];
  const text = [`新着 ${articles.length} 件`, sheetUrl, ''];

  categories.forEach((category) => {
    const inCategory = articles.filter((a) => a.category === category);
    if (!inCategory.length) return;
    html.push(`<h2 style="border-bottom:2px solid #444">${escapeHtml_(category)}（${inCategory.length}件）</h2>`);
    text.push(`■ ${category}（${inCategory.length}件）`);

    langs.forEach((lang) => {
      const group = inCategory.filter((a) => a.lang === lang);
      if (!group.length) return;
      const shown = group.slice(0, NEWS_CONFIG.MAX_ITEMS_PER_GROUP_IN_MAIL);
      const label = NEWS_EDITIONS[lang].label;
      html.push(`<h3 style="margin-bottom:4px">${label}（${group.length}件）</h3><ul>`);
      text.push(`  [${label}]`);

      shown.forEach((a) => {
        const time = Utilities.formatDate(a.published, tz, 'MM/dd HH:mm');
        const headline = a.titleJa || a.title;
        const original = a.titleJa ? `<br><span style="color:#888;font-size:12px">${escapeHtml_(a.title)}</span>` : '';
        html.push(
          `<li style="margin-bottom:6px"><a href="${escapeHtml_(a.url)}">${escapeHtml_(headline)}</a>` +
            ` <span style="color:#888;font-size:12px">${escapeHtml_(a.source)} ${time}</span>${original}</li>`
        );
        text.push(`  - ${headline}（${a.source} ${time}）`, `    ${a.url}`);
      });
      if (group.length > shown.length) {
        html.push(`<li style="color:#888">ほか ${group.length - shown.length} 件はスプレッドシート参照</li>`);
      }
      html.push('</ul>');
    });
    text.push('');
  });

  const to = NEWS_CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
  GmailApp.sendEmail(to, subject, text.join('\n'), { htmlBody: html.join('\n') });
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * NEWS_CONFIG.RUN_HOURS の各時刻に collectNews を実行するトリガーを設置する。
 * 既存の collectNews トリガーは削除してから作り直すため、複数回実行しても重複しない。
 */
function createNewsTriggers() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'collectNews')
    .forEach((t) => ScriptApp.deleteTrigger(t));

  NEWS_CONFIG.RUN_HOURS.forEach((hour) => {
    ScriptApp.newTrigger('collectNews').timeBased().everyDays(1).atHour(hour).create();
  });
}
