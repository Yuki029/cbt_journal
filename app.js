/* =======================================================================
   こころの記録 — CBT Journal
   - 記録はこの端末内でAES-GCM暗号化して保存
   - Supabaseへは暗号化済みデータのみを自動同期（記録ごとに競合を確認）
   ======================================================================= */

const STORE = 'kokoro-cbt-v1';
const SYNC = 'kokoro-supabase-config-v1';
const DEVKEY = 'kokoro-device-v1';
const SCHEMA = 3;
const POLL_MS = 45000;      // 定期的な取得
const PUSH_DELAY_MS = 1200; // 保存後に送信するまでの待ち時間

let key = null;          // この端末のsaltから作った鍵
let sessionPin = null;   // 他端末のsaltで復号するため、ロック解除中だけ保持
let state = { records: [], deleted: {}, base: {} };
let page = 'home', editingId = null, selected = new Set(), supabaseClient = null;

const sync = {
  status: 'off',   // off | syncing | ok | offline | error | conflict
  detail: '',
  at: '',
  busy: false,
  pending: false,
  timer: null,
  channel: null,
  lastPush: '',
  dialogOpen: false
};

/* ---------- 小さな道具 ---------- */
const $ = s => document.querySelector(s);
const app = $('#app');
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = x => btoa(String.fromCharCode(...new Uint8Array(x)));
const unb64 = x => Uint8Array.from(atob(x), c => c.charCodeAt(0));
const esc = x => { const e = document.createElement('div'); e.textContent = x == null ? '' : x; return e.innerHTML; };
const date = x => new Intl.DateTimeFormat('ja-JP', { dateStyle: 'long' }).format(new Date(x + 'T00:00:00'));
const stamp = x => x ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(x)) : '日時不明';
const clock = x => x ? new Intl.DateTimeFormat('ja-JP', { timeStyle: 'short' }).format(new Date(x)) : '';
const nowISO = () => new Date().toISOString();

function deviceId() {
  let id = localStorage.getItem(DEVKEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVKEY, id); }
  return id;
}

/* =======================================================================
   認知のゆがみ辞典
   ======================================================================= */
const DISTORTIONS = [
  {
    id: 'all_or_nothing', name: '完全主義（全か無か）', short: '白か黒かで判断する',
    desc: '物事を「成功か失敗か」「完璧かダメか」の二択で見てしまう考え方です。中間の評価がなくなるため、少しの不足で「全部だめだった」と感じやすくなります。',
    signs: ['「完璧」「絶対」「台無し」という言葉が浮かぶ', '一つできないと、できた部分が見えなくなる'],
    example: 'テストで95点を取ったが、満点ではなかったので「自分は失敗した」と落ち込む。',
    fix: ['0か100かではなく、0〜100の物差しで「今回は何点くらいか」を数字にする', '「完璧」ではなく「合格ライン」を先に決めておく', 'うまくいった部分を具体的に3つ書き出す'],
    ask: ['本当に「全部」だめでしたか。うまくいった部分はどこですか', '同じ出来事を友人が話したら、何点をつけますか']
  },
  {
    id: 'overgeneralization', name: '過度の一般化', short: '一度の出来事を「いつも」に広げる',
    desc: '一度や二度の経験から「いつもこうなる」「何をやってもだめだ」と結論づける考え方です。たまたま起きたことが、変わらない法則のように感じられます。',
    signs: ['「いつも」「みんな」「二度と」「どうせ」が口ぐせになる', '一つの失敗を人生全体の話に広げてしまう'],
    example: '一件の誘いを断られて、「自分は誰からも誘われない人間だ」と考える。',
    fix: ['「いつも」を「今回は」に言い換えてみる', '反対の証拠（うまくいった回）を具体的に挙げる', '回数を数える。「10回のうち何回そうなったか」を確かめる'],
    ask: ['本当に毎回そうでしたか。例外はありませんでしたか', 'この一件は、どのくらいの範囲のことを言えますか']
  },
  {
    id: 'mental_filter', name: '心のフィルター', short: '悪い一点だけが目に入る',
    desc: '全体の中の否定的な部分だけを取り出して見続け、他の情報が視界から消えてしまう考え方です。よい出来事があっても記憶に残りにくくなります。',
    signs: ['ほめ言葉より、一つの指摘ばかり思い返す', '出来事を振り返ると、悪い場面だけ再生される'],
    example: '発表後に9人からよい感想をもらったが、1人の厳しい意見だけが頭から離れない。',
    fix: ['起きたことを一度すべて書き出し、よい／中立／悪いに仕分ける', '一日の終わりに、うまくいったことを3つ記録する', '指摘の内容を「事実」と「解釈」に分けて書く'],
    ask: ['同じ場面で、他に何が起きていましたか', 'その一点は、全体の何割にあたりますか']
  },
  {
    id: 'disqualifying_positive', name: 'マイナス化思考', short: 'よいことを打ち消す',
    desc: 'うまくいったことを「たまたま」「当然」と値引きして、意味のない出来事に変えてしまう考え方です。努力や成果が自分の中に積み上がりません。',
    signs: ['ほめられると「お世辞だ」「運がよかっただけ」と考える', '成功したのに気分が晴れない'],
    example: '企画が通ったのに、「今回は競合が弱かっただけで自分の力ではない」と考える。',
    fix: ['自分がした行動を具体的に書き出し、運と行動を分ける', 'ほめ言葉は「ありがとうございます」で受け取り、その場で反論しない', '成果メモを残し、後で読み返す'],
    ask: ['自分が何もしなくても、同じ結果になりましたか', 'この結果に、自分の行動はどのくらい関わっていますか']
  },
  {
    id: 'mind_reading', name: '結論の飛躍（心の読みすぎ）', short: '相手の考えを決めつける',
    desc: '確かめていないのに、相手が自分をどう思っているかを決めてしまう考え方です。相手の短い反応が、否定的な気持ちの証拠のように見えます。',
    signs: ['「きっと嫌われた」「呆れられた」と感じる', '相手の表情や返信の速さから気持ちを推測する'],
    example: '返信が短かっただけで、「怒らせてしまった」と確信する。',
    fix: ['その考えを支える事実と、反する事実を並べて書く', '他に考えられる理由を3つ挙げる（忙しい・移動中・特に意味はない）', '気になる相手には、短い言葉で直接確かめる'],
    ask: ['相手がそう思っている証拠は何ですか', '他にどんな理由が考えられますか']
  },
  {
    id: 'fortune_telling', name: '結論の飛躍（先読みの誤り）', short: '悪い結末を決めつける',
    desc: 'これから起こることを悪い方に決めつけ、すでに決まったことのように感じる考え方です。不安から回避が増え、確かめる機会が減っていきます。',
    signs: ['「どうせ失敗する」「行っても無駄だ」と考える', '始める前から諦めたくなる'],
    example: '面接の前から「絶対に落ちる」と考え、準備が手につかない。',
    fix: ['予想した結果と実際の結果を記録し、後で答え合わせをする', '起こりうる結末を、最悪・最良・現実的の3つ書く', '小さく試して、実際に何が起きるか確かめる'],
    ask: ['その予想が当たる確率は、実際どのくらいですか', '過去に同じ予想をしたとき、結果はどうでしたか']
  },
  {
    id: 'magnification', name: '拡大解釈と過小評価', short: '欠点は大きく、長所は小さく見る',
    desc: '自分の失敗や欠点を実物より大きく、長所や他人の失敗を小さく見てしまう考え方です。同じ出来事でも、自分に向けるときだけ物差しが変わります。',
    signs: ['自分のミスは重大、他人の同じミスは些細に思える', '長所を語ると落ち着かない'],
    example: '会議での言い間違いを「取り返しがつかない失態」と考える一方、担当業務をやり切ったことは数に入れない。',
    fix: ['同じ出来事を同僚がしたと想像し、そのときの評価と比べる', '影響の範囲と期間を書き出す（誰に、いつまで）', '事実を数字と時間で表す'],
    ask: ['1週間後、1年後にはどのくらいの問題ですか', '同じことを他の人がしたら、同じ評価をしますか']
  },
  {
    id: 'emotional_reasoning', name: '感情的決めつけ', short: '感じたことを事実とみなす',
    desc: '「そう感じる」ことを「それが事実だ」の証拠にしてしまう考え方です。強い感情ほど、確かな根拠のように感じられます。',
    signs: ['「不安だから危険だ」「気が重いから無理だ」と考える', '気分によって、同じ計画の見え方が大きく変わる'],
    example: '緊張しているので、「自分にはこの仕事ができない」と結論づける。',
    fix: ['「私は〜と感じる」と「事実は〜だ」を2行に分けて書く', '気分が落ち着いた時間に、同じ出来事をもう一度書く', '感情の強さ（0〜10）と、根拠の数を並べて記録する'],
    ask: ['それは気持ちですか、それとも確かめられる事実ですか', '同じ状況を落ち着いているときに見たら、どう見えますか']
  },
  {
    id: 'should_statements', name: 'べき思考', short: '「〜すべき」で自分と人を縛る',
    desc: '「〜すべき」「〜してはいけない」という規則で自分や他人を評価する考え方です。守れないと罪悪感、他人が守らないと怒りが生まれやすくなります。',
    signs: ['「べき」「ねばならない」「普通は」が浮かぶ', 'できなかったときに強い自責を感じる'],
    example: '「人に頼ってはいけない」と考え、余裕がないのに助けを求められない。',
    fix: ['「〜すべき」を「〜できたら望ましい」に言い換える', 'その規則の出どころと、今も役に立っているかを確かめる', '守れなかったときの現実的な結果を書き出す'],
    ask: ['その規則は誰が決めたものですか', '「望ましい」と「必ず」の間に、どんな幅がありますか']
  },
  {
    id: 'labeling', name: 'レッテル貼り', short: '行動ではなく人格に名前をつける',
    desc: '一つの行動を根拠に、自分や他人そのものに「だめな人間」などの名前をつけてしまう考え方です。人格の話になるため、改善の手がかりが見えなくなります。',
    signs: ['「私はだめな人間だ」「あの人は無責任だ」と考える', '出来事より、人柄の評価が先に出てくる'],
    example: '一度遅刻したことで、「自分はいい加減な人間だ」と考える。',
    fix: ['人格ではなく行動で言い直す（「私はだめだ」→「今日は10分遅刻した」）', '次にできる具体的な行動を一つ決める', '同じ言葉を大切な人に言えるか確かめる'],
    ask: ['それは「その人そのもの」ですか、「一つの行動」ですか', '行動の言葉に置き換えると、どう書けますか']
  },
  {
    id: 'personalization', name: '個人化', short: '自分のせいだと引き受けすぎる',
    desc: '自分に責任のない出来事まで、自分のせいだと結びつけてしまう考え方です。関わった要因が多くても、原因が自分に集まって見えます。',
    signs: ['場の空気が悪いと、自分が原因だと感じる', '謝る回数が多い'],
    example: 'チームの遅れについて、他の要因があるのに「自分の力不足のせいだ」と考える。',
    fix: ['原因の円グラフを描き、関わった要因に割合を配る', '自分に変えられる範囲と、変えられない範囲を分けて書く', '責任と役割を区別して言葉にする'],
    ask: ['この結果に関わった要因を、他に何個挙げられますか', '自分の分は全体の何％くらいですか']
  }
];
const DMAP = Object.fromEntries(DISTORTIONS.map(d => [d.id, d]));
const distortionsOf = r => Array.isArray(r?.distortions) ? r.distortions.filter(id => DMAP[id]) : [];
const distortionNames = r => distortionsOf(r).map(id => DMAP[id].name);

/* =======================================================================
   保存・暗号化
   ======================================================================= */
async function derive(pin, salt) {
  const m = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(salt), iterations: 150000, hash: 'SHA-256' },
    m, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const localBox = () => JSON.parse(localStorage.getItem(STORE) || '{}');

async function encryptWith(useKey, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, useKey, enc.encode(JSON.stringify(payload)));
  return { iv: b64(iv), data: b64(data) };
}
async function decryptWith(useKey, box) {
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, useKey, unb64(box.data))));
}

/** ローカルへ保存。skipSync=true のときはクラウド送信を予約しない */
async function save(skipSync = false) {
  const box = localBox();
  const { iv, data } = await encryptWith(key, state);
  Object.assign(box, { iv, data, updatedAt: nowISO(), schema: SCHEMA });
  localStorage.setItem(STORE, JSON.stringify(box));
  if (!skipSync) schedulePush();
}

/** 記録を更新したときの共通処理（更新日時を打つ） */
function touch(record) { record.updatedAt = nowISO(); return record; }

function normalizeState(s) {
  const out = { records: Array.isArray(s?.records) ? s.records : [], deleted: s?.deleted || {}, base: s?.base || {} };
  const fallback = localBox().updatedAt || '1970-01-01T00:00:00.000Z';
  out.records.forEach(r => {
    if (!r.id) r.id = crypto.randomUUID();
    if (!r.updatedAt) r.updatedAt = fallback;
    if (!Array.isArray(r.distortions)) r.distortions = [];
  });
  return out;
}

function purgeTombstones() {
  const limit = new Date(Date.now() - 90 * 864e5).toISOString();
  for (const [id, t] of Object.entries(state.deleted)) if (t < limit) delete state.deleted[id];
}

async function setup(pin) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  key = await derive(pin, salt);
  sessionPin = pin;
  state = { records: [], deleted: {}, base: {} };
  localStorage.setItem(STORE, JSON.stringify({ salt, iv: '', data: '', schema: SCHEMA }));
  await save(true);
  page = 'home'; render();
  startSync();
}

async function unlock(pin) {
  try {
    const box = localBox();
    key = await derive(pin, box.salt);
    state = normalizeState(await decryptWith(key, box));
    sessionPin = pin;
    purgeTombstones();
    page = 'home'; render();
    startSync();
    return true;
  } catch { return false; }
}

function lock() {
  stopSync();
  key = null; sessionPin = null; remoteKeys.clear();
  state = { records: [], deleted: {}, base: {} };
  selected.clear(); editingId = null;
  showUnlock();
}

/* =======================================================================
   認証画面
   ======================================================================= */
function showSetup() {
  app.innerHTML = $('#onboarding-template').innerHTML;
  $('#setup-form').onsubmit = async e => {
    e.preventDefault();
    const p = $('#setup-pin').value;
    if (p !== $('#setup-pin-confirm').value) return alert('パスコードが一致しません。');
    await setup(p);
  };
}
function showUnlock() {
  app.innerHTML = $('#unlock-template').innerHTML;
  $('#unlock-form').onsubmit = async e => {
    e.preventDefault();
    if (!await unlock($('#unlock-pin').value)) $('#unlock-error').hidden = false;
  };
}

/* =======================================================================
   共通レイアウト
   ======================================================================= */
const NAV_ITEMS = [
  ['home', '記録一覧'], ['new', '＋ 新しい記録'], ['guide', '認知のゆがみ辞典'],
  ['export', '▣ PDF出力'], ['settings', '設定・データ管理']
];

function nav() {
  const items = NAV_ITEMS.map(([p, label]) => `<button data-page="${p}"${page === p ? ' class="active"' : ''}>${label}</button>`).join('');
  return `<aside class="sidebar"><div class="logo">○ こころの記録<span>CBT JOURNAL</span></div>
  <nav class="nav">${items}</nav>
  <div class="sidebar-bottom">${syncBadge(true)}<button class="lock-button" data-lock>🔒 ロックする</button></div></aside>
  <div class="mobile-top"><strong>○ こころの記録</strong><button data-menu>メニュー</button></div>`;
}

function bind() {
  document.querySelectorAll('[data-page]').forEach(b => b.onclick = () => { page = b.dataset.page; editingId = b.dataset.record || null; render(); });
  document.querySelectorAll('[data-lock]').forEach(b => b.onclick = lock);
  document.querySelectorAll('[data-sync-now]').forEach(b => b.onclick = () => syncNow({ push: true, force: true }));
  $('[data-menu]')?.addEventListener('click', () => {
    const open = $('.mobile-menu');
    if (open) return open.remove();
    const m = document.createElement('nav');
    m.className = 'mobile-menu';
    m.innerHTML = NAV_ITEMS.map(([p, label]) => `<button data-page="${p}">${label}</button>`).join('') + '<button data-lock>🔒 ロックする</button>';
    $('.mobile-top').after(m); bind();
  });
  document.querySelectorAll('[data-info]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); openDistortion(b.dataset.info); });
  document.querySelectorAll('[data-guide]').forEach(b => b.onclick = e => { e.preventDefault(); openGuideModal(); });
}

function layout(x) {
  app.innerHTML = `<div class="app-layout">${nav()}<main class="content">${x}</main></div>`;
  bind();
}

const lockBtn = '<button class="lock-compact" data-lock>🔒 ロック</button>';

/* =======================================================================
   同期の状態表示
   ======================================================================= */
const SYNC_LABEL = {
  off: ['同期オフ', '設定・データ管理から有効にできます'],
  syncing: ['同期中…', 'クラウドと照合しています'],
  ok: ['同期済み', ''],
  offline: ['オフライン', '接続が戻ると自動で同期します'],
  error: ['同期エラー', ''],
  conflict: ['確認待ち', '競合した記録の扱いを選んでください']
};

function syncBadge(sidebar = false) {
  const [label, note] = SYNC_LABEL[sync.status] || SYNC_LABEL.off;
  const time = sync.status === 'ok' && sync.at ? ` ${clock(sync.at)}` : '';
  const title = esc(sync.detail || note);
  return `<div class="sync-badge${sidebar ? ' sync-badge-side' : ''}" data-sync-badge data-state="${sync.status}" title="${title}">
    <span class="sync-dot"></span><span>${label}${time}</span>
    ${sync.status === 'off' ? '' : '<button class="sync-refresh" data-sync-now aria-label="今すぐ同期">⟳</button>'}</div>`;
}

function setSyncStatus(status, detail = '') {
  sync.status = status; sync.detail = detail;
  if (status === 'ok') sync.at = nowISO();
  document.querySelectorAll('[data-sync-badge]').forEach(el => {
    const side = el.classList.contains('sync-badge-side');
    const wrap = document.createElement('div');
    wrap.innerHTML = syncBadge(side);
    el.replaceWith(wrap.firstElementChild);
  });
  document.querySelectorAll('[data-sync-now]').forEach(b => b.onclick = () => syncNow({ push: true, force: true }));
  const msg = $('[data-sync-message]');
  if (msg && detail) { msg.hidden = false; msg.textContent = detail; msg.className = status === 'error' ? 'error' : 'hint'; }
}

/* =======================================================================
   記録一覧
   ======================================================================= */
function distortionTags(r, small = false) {
  const names = distortionNames(r);
  if (!names.length) return '';
  return `<div class="tag-row${small ? ' tag-row-small' : ''}">${names.map(n => `<span class="tag tag-distortion">${esc(n)}</span>`).join('')}</div>`;
}

function home() {
  const cards = [...state.records].sort((a, b) => b.date.localeCompare(a.date)).map(r => `
    <article class="record-card" data-open="${r.id}">
      <label class="select-record"><input type="checkbox" data-select="${r.id}" ${selected.has(r.id) ? 'checked' : ''}> PDFに選択</label>
      <div class="record-date">${date(r.date)}</div>
      <h2>${esc(r.event || '出来事')}</h2>
      <p>${esc(r.mood || '感情は未記入です')}</p>
      ${distortionTags(r, true)}
      <span class="tag">感情の強さ ${r.before}/10 → ${r.after}/10</span>
    </article>`).join('') ||
    '<div class="empty">まだ記録がありません。<br>気になる出来事を、ひとつずつ書き留めてみましょう。</div>';

  layout(`<header class="page-header"><div><h1>記録一覧</h1><p>あなたのペースで、こころの動きを見つめます。</p></div>
    <div class="header-actions">${syncBadge()}<button class="secondary" data-page="export">PDF出力（${selected.size}件）</button><button class="primary" data-page="new">＋ 新しい記録</button>${lockBtn}</div></header>
    <section class="record-grid">${cards}</section>`);

  document.querySelectorAll('[data-open]').forEach(x => x.onclick = e => {
    if (e.target.closest('.select-record')) return;
    editingId = x.dataset.open; page = 'detail'; render();
  });
  document.querySelectorAll('[data-select]').forEach(x => x.onchange = () => {
    x.checked ? selected.add(x.dataset.select) : selected.delete(x.dataset.select); render();
  });
}

/* =======================================================================
   記録の編集
   ======================================================================= */
function field(label, name, value = '', type = 'text', full = true, help = '') {
  const c = type === 'textarea'
    ? `<textarea name="${name}" placeholder="ここに入力…">${esc(value)}</textarea>`
    : `<input name="${name}" type="${type}" value="${esc(value)}" ${name === 'date' ? 'required' : ''}>`;
  return `<label class="${full ? 'full' : ''}">${label}${help ? ` <span class="field-help">${help}</span>` : ''}${c}</label>`;
}

function distortionPicker(sel) {
  const chips = DISTORTIONS.map(d => `
    <label class="distortion-chip">
      <input type="checkbox" name="distortions" value="${d.id}" ${sel.includes(d.id) ? 'checked' : ''}>
      <span class="chip-body"><strong>${esc(d.name)}</strong><small>${esc(d.short)}</small></span>
      <button type="button" class="chip-info" data-info="${d.id}" aria-label="${esc(d.name)}の説明を見る">？</button>
    </label>`).join('');
  return `<div class="full distortion-field">
    <div class="field-title">認知のゆがみ <span class="field-help">あてはまるものをすべて選べます。？で説明・例・対処を確認できます。</span></div>
    <div class="distortion-grid">${chips}</div>
    <button type="button" class="link-button" data-guide>認知のゆがみ辞典をひらく</button>
  </div>`;
}

function editor() {
  const r = editingId ? state.records.find(x => x.id === editingId)
    : { date: new Date().toISOString().slice(0, 10), before: 5, after: 3, distortions: [] };
  layout(`<header class="page-header"><div><h1>${editingId ? '記録を編集' : '新しい記録'}</h1>
    <p>正解を探すためではなく、気持ちに気づくための記録です。</p></div>${lockBtn}</header>
    <form id="record-form" class="form-card"><div class="form-grid">
      ${field('日付', 'date', r.date, 'date', false)}
      ${field('出来事', 'event', r.event || '', 'text', false, '何がありましたか？')}
      ${field('出来事の詳細', 'eventDetail', r.eventDetail || '', 'textarea', true, '状況・相手・場所など、思い出せる範囲で')}
      ${field('認知前の感情（気分）', 'mood', r.mood || '', 'text', false, '例：不安、落ち込み、怒り')}
      ${field('自動思考', 'thought', r.thought || '', 'textarea')}
      ${distortionPicker(distortionsOf(r))}
      ${field('ゆがみについてのメモ', 'distortion', r.distortion || '', 'textarea', true, '選んだ理由や、当てはまらないと感じた点など')}
      ${field('別の見方／考え方', 'alternative', r.alternative || '', 'textarea')}
      ${field('CBTへの不明点・疑問点', 'question', r.question || '', 'textarea')}
      <label>認知前の感情の強さ<div class="range-row"><input name="before" type="range" min="0" max="10" value="${r.before}" oninput="this.nextElementSibling.textContent=this.value"><span class="range-value">${r.before}</span></div></label>
      <label>修正後の感情の強さ<div class="range-row"><input name="after" type="range" min="0" max="10" value="${r.after}" oninput="this.nextElementSibling.textContent=this.value"><span class="range-value">${r.after}</span></div></label>
      ${field('カウンセラーのフィードバック', 'feedback', r.feedback || '', 'textarea')}
    </div><div class="form-actions">
      <button type="button" class="secondary" data-page="${editingId ? 'detail' : 'home'}" data-record="${editingId || ''}">キャンセル</button>
      <button type="submit" class="primary">記録を保存</button></div></form>`);

  $('#record-form').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const d = Object.fromEntries(fd);
    d.distortions = fd.getAll('distortions');
    d.before = +d.before; d.after = +d.after;
    d.id = editingId || crypto.randomUUID();
    touch(d);
    if (editingId) state.records = state.records.map(x => x.id === editingId ? d : x);
    else state.records.push(d);
    await save();
    editingId = d.id; page = 'detail'; render();
  };
}

/* =======================================================================
   記録の詳細
   ======================================================================= */
const sec = (h, v) => `<section class="detail-section"><h3>${h}</h3><p>${esc(v || '—')}</p></section>`;

function detailDistortions(r) {
  const ids = distortionsOf(r);
  const body = ids.length
    ? `<div class="tag-row">${ids.map(id => `<button type="button" class="tag tag-distortion tag-button" data-info="${id}">${esc(DMAP[id].name)} ？</button>`).join('')}</div>`
    : '<p>—</p>';
  return `<section class="detail-section"><h3>認知のゆがみ</h3>${body}</section>`;
}

function detail() {
  const r = state.records.find(x => x.id === editingId);
  if (!r) { page = 'home'; return render(); }
  layout(`<header class="page-header"><div><h1>記録の詳細</h1></div>
    <div class="header-actions">${syncBadge()}<button class="secondary" data-page="home">一覧へ戻る</button>${lockBtn}</div></header>
    <article class="detail-card"><div class="detail-meta">${date(r.date)}</div>
    ${sec('出来事', r.event)}${sec('出来事の詳細', r.eventDetail)}${sec('認知前の感情（気分）', r.mood)}
    <section class="detail-section"><h3>感情の強さ</h3><span class="score-chip">認知前 ${r.before} / 10</span> → <span class="score-chip">修正後 ${r.after} / 10</span></section>
    ${sec('自動思考', r.thought)}
    ${detailDistortions(r)}
    ${sec('ゆがみについてのメモ', r.distortion)}
    ${sec('別の見方／考え方', r.alternative)}${sec('CBTへの不明点・疑問点', r.question)}${sec('カウンセラーのフィードバック', r.feedback)}
    <p class="record-updated">最終更新：${stamp(r.updatedAt)}</p>
    <div class="detail-actions"><button class="primary" data-edit>編集</button><button class="secondary" data-add>PDFに追加</button><button class="danger" data-del>この記録を削除</button></div></article>`);

  $('[data-edit]').onclick = () => { page = 'new'; render(); };
  $('[data-add]').onclick = () => { selected.add(r.id); page = 'export'; render(); };
  $('[data-del]').onclick = async () => {
    if (!confirm('この記録を削除しますか？')) return;
    state.records = state.records.filter(x => x.id !== r.id);
    state.deleted[r.id] = nowISO();
    delete state.base[r.id];
    selected.delete(r.id);
    await save(); page = 'home'; render();
  };
}

/* =======================================================================
   認知のゆがみ辞典
   ======================================================================= */
function distortionArticle(d) {
  return `<h3>${esc(d.name)}</h3><p class="guide-short">${esc(d.short)}</p>
    <p class="guide-desc">${esc(d.desc)}</p>
    <h4>気づきのサイン</h4><ul>${d.signs.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
    <h4>例</h4><p class="guide-example">${esc(d.example)}</p>
    <h4>対処のヒント</h4><ul>${d.fix.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
    <h4>自分への問いかけ</h4><ul>${d.ask.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`;
}

function guide() {
  const cards = DISTORTIONS.map(d => `<article class="guide-card" id="d-${d.id}">${distortionArticle(d)}</article>`).join('');
  const index = DISTORTIONS.map(d => `<a class="guide-link" href="#d-${d.id}">${esc(d.name)}</a>`).join('');
  layout(`<header class="page-header"><div><h1>認知のゆがみ辞典</h1>
    <p>認知行動療法で使われる11の考え方のくせです。責めるための分類ではなく、別の見方を探す手がかりとして使います。</p></div>
    <div class="header-actions"><button class="primary" data-page="new">＋ 新しい記録</button>${lockBtn}</div></header>
    <nav class="guide-index">${index}</nav>
    <p class="notice">気持ちが強く動いているときは、まず出来事と感情を書くだけで十分です。分類は後からで構いません。つらさが続くときは、専門家に相談することも選択肢のひとつです。</p>
    <section class="guide-grid">${cards}</section>`);
}

function openDistortion(id) {
  const d = DMAP[id]; if (!d) return;
  openModal(`<article class="guide-card modal-card">${distortionArticle(d)}</article>`);
}

function openGuideModal() {
  const cards = DISTORTIONS.map(d => `<article class="guide-card">${distortionArticle(d)}</article>`).join('');
  openModal(`<div class="modal-card"><h2>認知のゆがみ辞典</h2>
    <p class="hint">責めるための分類ではなく、別の見方を探す手がかりとして使います。</p>
    <div class="guide-grid guide-grid-modal">${cards}</div></div>`);
}

function openModal(html) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-layer';
  wrap.innerHTML = `<div class="modal-panel" role="dialog" aria-modal="true"><button class="modal-close" aria-label="閉じる">×</button>${html}</div>`;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  wrap.onclick = e => { if (e.target === wrap) close(); };
  wrap.querySelector('.modal-close').onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
}

/* =======================================================================
   PDF出力
   ======================================================================= */
function exportPage() {
  const records = state.records.filter(x => selected.has(x.id));
  const list = state.records.map(r => `<label class="export-choice"><input type="checkbox" data-export="${r.id}" ${selected.has(r.id) ? 'checked' : ''}>
    <span><strong>${esc(r.event || '出来事')}</strong><small>${date(r.date)} ／ ${esc(r.mood || '感情未記入')}</small></span></label>`).join('')
    || '<p class="hint">まずは記録を作成してください。</p>';
  layout(`<header class="page-header"><div><h1>PDF出力</h1><p>出力する出来事を選択し、まとめて印刷またはPDF保存できます。</p></div>${lockBtn}</header>
    <section class="form-card export-card"><h2>出力する記録（${records.length}件）</h2><div class="export-list">${list}</div>
    <div class="form-actions"><button class="secondary" data-page="home">一覧へ戻る</button>
    <button class="primary" data-preview ${records.length ? '' : 'disabled'}>印刷用ページを作成</button></div></section>`);
  document.querySelectorAll('[data-export]').forEach(x => x.onchange = () => {
    x.checked ? selected.add(x.dataset.export) : selected.delete(x.dataset.export); render();
  });
  $('[data-preview]')?.addEventListener('click', () => { page = 'print'; render(); });
}

function printItem(r) {
  const names = distortionNames(r);
  const dist = names.length
    ? `<section class="detail-section"><h3>認知のゆがみ</h3><p>${names.map(esc).join('／')}</p></section>`
    : sec('認知のゆがみ', '');
  return `<article class="print-entry"><h2>${esc(r.event || '出来事')}</h2><p class="print-date">${date(r.date)}</p>
    ${sec('出来事の詳細', r.eventDetail)}${sec('認知前の感情（気分）', r.mood)}
    <section class="detail-section"><h3>感情の強さ</h3><p>認知前：${r.before} / 10　→　修正後：${r.after} / 10</p></section>
    ${sec('自動思考', r.thought)}${dist}${sec('ゆがみについてのメモ', r.distortion)}
    ${sec('別の見方／考え方', r.alternative)}${sec('CBTへの不明点・疑問点', r.question)}
    <section class="counselor-space"><h3>カウンセラーからのフィードバック</h3>
    <p>（この欄は記入用です。アプリ内のフィードバック本文は出力されません。）</p></section></article>`;
}

function printPage() {
  const a = state.records.filter(x => selected.has(x.id));
  app.innerHTML = `<main class="print-screen"><div class="print-toolbar">
    <button class="secondary" data-back>選択に戻る</button><button class="primary" data-print>印刷／PDFとして保存</button></div>
    <article class="print-document"><h1>こころの記録 — CBT記録シート</h1><p class="print-intro">${a.length}件</p>
    ${a.map(printItem).join('')}</article></main>`;
  $('[data-back]').onclick = () => { page = 'export'; render(); };
  $('[data-print]').onclick = () => window.print();
}

/* =======================================================================
   Supabase 同期
   ======================================================================= */
const remoteKeys = new Map(); // salt -> CryptoKey

function getSyncConfig() { try { return JSON.parse(localStorage.getItem(SYNC) || '{}'); } catch { return {}; } }
const syncConfigured = () => { const c = getSyncConfig(); return !!(c.url && c.anonKey); };

function connectSync() {
  const c = getSyncConfig();
  if (!c.url || !c.anonKey) throw Error('Supabaseの接続情報を設定してください。');
  if (!window.supabase) throw Error('Supabaseのライブラリを読み込めませんでした。');
  if (!supabaseClient) supabaseClient = window.supabase.createClient(c.url, c.anonKey);
  return supabaseClient;
}

async function syncUser() {
  const client = connectSync();
  const { data: { user } } = await client.auth.getUser();
  if (!user) throw Error('Supabaseにログインしてください。');
  return user;
}

async function keyForSalt(salt) {
  if (salt === localBox().salt) return key;
  if (remoteKeys.has(salt)) return remoteKeys.get(salt);
  if (!sessionPin) throw Error('復号のためロックを解除し直してください。');
  const k = await derive(sessionPin, salt);
  remoteKeys.set(salt, k);
  return k;
}

/** クラウドの行を取得（なければ null） */
async function fetchCloud() {
  const user = await syncUser();
  const { data, error } = await supabaseClient.from('cbt_sync').select('encrypted_data,updated_at').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  return data?.encrypted_data || null;
}

/** クラウドの箱を復号して {records, deleted, updatedAt} を返す */
async function readCloud(box) {
  const k = await keyForSalt(box.salt);
  const p = await decryptWith(k, box);
  return {
    records: (p.records || []).map(r => ({ ...r, updatedAt: r.updatedAt || box.updatedAt || '1970-01-01T00:00:00.000Z', distortions: Array.isArray(r.distortions) ? r.distortions : [] })),
    deleted: p.deleted || {},
    updatedAt: p.updatedAt || box.updatedAt || ''
  };
}

/** 今のstateを暗号化してクラウドへ送信 */
async function pushCloud() {
  const user = await syncUser();
  const payload = { records: state.records, deleted: state.deleted, updatedAt: nowISO(), device: deviceId() };
  const { iv, data } = await encryptWith(key, payload);
  const box = { salt: localBox().salt, iv, data, updatedAt: payload.updatedAt, device: payload.device, schema: SCHEMA };
  const { error } = await supabaseClient.from('cbt_sync').upsert({ user_id: user.id, encrypted_data: box, updated_at: box.updatedAt });
  if (error) throw error;
  sync.lastPush = box.updatedAt;
  state.base = Object.fromEntries(state.records.map(r => [r.id, r.updatedAt]));
  await save(true);
}

/* ---------- 競合の確認ダイアログ ---------- */
function conflictRow(label, a, b) {
  return `<div class="conflict-row"><span class="conflict-label">${label}</span>
    <span>${esc(a || '—')}</span><span>${esc(b || '—')}</span></div>`;
}

function conflictSummary(local, remote) {
  const d = r => distortionNames(r).join('／');
  return `<div class="conflict-table">
    <div class="conflict-row conflict-head"><span class="conflict-label"></span><span>この端末</span><span>クラウド</span></div>
    ${conflictRow('更新', stamp(local?.updatedAt), stamp(remote?.updatedAt))}
    ${conflictRow('出来事', local?.event, remote?.event)}
    ${conflictRow('感情', local?.mood, remote?.mood)}
    ${conflictRow('自動思考', local?.thought, remote?.thought)}
    ${conflictRow('ゆがみ', d(local), d(remote))}
    ${conflictRow('別の見方', local?.alternative, remote?.alternative)}
  </div>`;
}

function conflictDialog(item, index, total) {
  sync.dialogOpen = true;
  return new Promise(resolve => {
    const title = esc(item.local?.event || item.remote?.event || '出来事');
    let heading, lead, actions;
    if (item.type === 'both') {
      heading = 'この出来事が両方の端末で編集されています';
      lead = '同じ出来事に別々の変更があります。どちらの内容で上書きするか選んでください。';
      actions = `<button class="secondary" data-choice="remote">クラウドの内容で上書き</button>
        <button class="primary" data-choice="local">この端末の内容で上書き</button>
        <button class="secondary" data-choice="both">両方を残す</button>`;
    } else if (item.type === 'deleted-remote') {
      heading = 'この出来事は他の端末で削除されています';
      lead = 'この端末には変更が残っています。削除を反映するか、記録を残すか選んでください。';
      actions = `<button class="danger" data-choice="remote">削除を反映する</button>
        <button class="primary" data-choice="local">この端末の記録を残す</button>`;
    } else {
      heading = 'この出来事は他の端末で編集されています';
      lead = 'この端末では削除しましたが、クラウドではその後に編集されています。';
      actions = `<button class="secondary" data-choice="remote">クラウドの記録を復元</button>
        <button class="primary" data-choice="local">削除したままにする</button>`;
    }
    const d = document.createElement('div');
    d.className = 'sync-conflict';
    d.innerHTML = `<section class="sync-conflict-card">
      <p class="eyebrow">同期の競合（${index} / ${total}）</p>
      <h2>${heading}</h2>
      <p class="conflict-title">「${title}」</p>
      <p>${lead}</p>
      ${conflictSummary(item.local, item.remote)}
      <div class="conflict-actions">${actions}<button class="link-button" data-choice="skip">あとで決める</button></div>
    </section>`;
    document.body.append(d);
    d.querySelectorAll('[data-choice]').forEach(b => b.onclick = () => {
      d.remove(); sync.dialogOpen = false; resolve(b.dataset.choice);
    });
  });
}

/* ---------- マージ ---------- */
function upsertLocal(record) {
  const i = state.records.findIndex(x => x.id === record.id);
  if (i >= 0) state.records[i] = record; else state.records.push(record);
}
function removeLocal(id) {
  state.records = state.records.filter(x => x.id !== id);
  selected.delete(id);
}

/**
 * ローカルとクラウドを記録単位で突き合わせる。
 * base（前回同期時の更新日時）と比べ、両方が変わっていれば競合ダイアログを出す。
 */
async function mergeRemote(remote) {
  const conflicts = [];
  let changed = false, needsPush = false, skipped = false;
  const localById = new Map(state.records.map(r => [r.id, r]));
  const remoteById = new Map(remote.records.map(r => [r.id, r]));

  for (const r of remote.records) {
    const l = localById.get(r.id), base = state.base[r.id], del = state.deleted[r.id];
    if (!l) {
      if (del) {
        if (del >= r.updatedAt) { needsPush = true; continue; }        // こちらの削除が新しい
        conflicts.push({ type: 'deleted-local', remote: r }); continue; // 削除後に相手が編集
      }
      upsertLocal(r); state.base[r.id] = r.updatedAt; changed = true; continue;
    }
    if (l.updatedAt === r.updatedAt) { state.base[r.id] = r.updatedAt; continue; }
    if (base === l.updatedAt) { upsertLocal(r); state.base[r.id] = r.updatedAt; changed = true; continue; } // 手元は未変更
    if (base === r.updatedAt) { needsPush = true; continue; }                                               // クラウドが未変更
    conflicts.push({ type: 'both', local: l, remote: r });
  }

  for (const [id, t] of Object.entries(remote.deleted || {})) {
    const l = localById.get(id);
    if (!l) { if (!state.deleted[id]) { state.deleted[id] = t; changed = true; } continue; }
    const base = state.base[id];
    if (base === l.updatedAt || l.updatedAt < t) {
      removeLocal(id); state.deleted[id] = t; delete state.base[id]; changed = true;
    } else {
      conflicts.push({ type: 'deleted-remote', local: l, at: t });
    }
  }

  for (const r of state.records) if (!remoteById.has(r.id)) needsPush = true;
  for (const id of Object.keys(state.deleted)) if (!(remote.deleted || {})[id]) needsPush = true;

  if (conflicts.length) {
    setSyncStatus('conflict');
    let i = 0;
    for (const c of conflicts) {
      i++;
      const choice = await conflictDialog(c, i, conflicts.length);
      if (choice === 'skip') { skipped = true; continue; }
      if (c.type === 'both') {
        if (choice === 'local') { state.base[c.local.id] = ''; needsPush = true; }
        else if (choice === 'remote') { upsertLocal(c.remote); state.base[c.remote.id] = c.remote.updatedAt; changed = true; }
        else { // 両方を残す
          const copy = { ...c.remote, id: crypto.randomUUID(), event: `${c.remote.event || '出来事'}（クラウド版）` };
          touch(copy); upsertLocal(copy); changed = true; needsPush = true;
        }
      } else if (c.type === 'deleted-remote') {
        if (choice === 'remote') { removeLocal(c.local.id); state.deleted[c.local.id] = c.at; changed = true; }
        else { delete state.deleted[c.local.id]; touch(c.local); upsertLocal(c.local); changed = true; needsPush = true; }
      } else { // deleted-local
        if (choice === 'remote') { delete state.deleted[c.remote.id]; upsertLocal(c.remote); state.base[c.remote.id] = c.remote.updatedAt; changed = true; needsPush = true; }
        else { state.deleted[c.remote.id] = nowISO(); needsPush = true; }
      }
    }
  }
  return { changed, needsPush, skipped };
}

/* ---------- 同期の実行 ---------- */
function schedulePush() {
  if (!syncConfigured() || !key) return;
  clearTimeout(sync.pushTimer);
  sync.pushTimer = setTimeout(() => syncNow({ push: true }), PUSH_DELAY_MS);
}

async function syncNow({ push = false, force = false } = {}) {
  if (!syncConfigured() || !key) return;
  if (sync.busy || sync.dialogOpen) { sync.pending = true; return; }
  if (page === 'new' && !force) { sync.pending = true; return; } // 入力中は中断しない
  sync.busy = true;
  setSyncStatus('syncing');
  let result = { changed: false, needsPush: push, skipped: false };
  try {
    const box = await fetchCloud();
    if (!box) {
      await pushCloud();
    } else if (box.updatedAt && box.updatedAt === sync.lastPush && !push) {
      // 自分が送った内容がそのまま返ってきただけ
    } else {
      const remote = await readCloud(box);
      const merged = await mergeRemote(remote);
      result = { ...merged, needsPush: merged.needsPush || push };
      if (merged.changed) await save(true);
      if (result.needsPush && !merged.skipped) await pushCloud();
      else if (merged.changed) await save(true);
    }
    setSyncStatus(result.skipped ? 'conflict' : 'ok', result.skipped ? '未解決の競合があります。次回もう一度確認します。' : '');
    if (result.changed && page !== 'new') render();
  } catch (e) {
    const offline = !navigator.onLine || /fetch|network|Failed to fetch/i.test(e?.message || '');
    setSyncStatus(offline ? 'offline' : 'error', e?.message || '同期に失敗しました。');
  } finally {
    sync.busy = false;
    if (sync.pending) { sync.pending = false; setTimeout(() => syncNow(), 400); }
  }
}

async function watchCloud() {
  try {
    const user = await syncUser();
    sync.channel?.unsubscribe();
    sync.channel = supabaseClient
      .channel('cbt-sync-' + user.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cbt_sync', filter: `user_id=eq.${user.id}` },
        payload => {
          const at = payload?.new?.encrypted_data?.updatedAt;
          if (at && at === sync.lastPush) return; // 自分の送信
          syncNow();
        })
      .subscribe();
  } catch { /* リアルタイムが使えない場合は定期取得のみ */ }
}

function startSync() {
  if (!syncConfigured()) { setSyncStatus('off'); return; }
  try { connectSync(); } catch (e) { setSyncStatus('error', e.message); return; }
  stopTimers();
  sync.timer = setInterval(() => syncNow(), POLL_MS);
  window.addEventListener('focus', onWake);
  window.addEventListener('online', onWake);
  document.addEventListener('visibilitychange', onVisible);
  watchCloud();
  syncNow();
}
const onWake = () => syncNow();
const onVisible = () => { if (document.visibilityState === 'visible') syncNow(); };

function stopTimers() {
  clearInterval(sync.timer); sync.timer = null;
  clearTimeout(sync.pushTimer);
  window.removeEventListener('focus', onWake);
  window.removeEventListener('online', onWake);
  document.removeEventListener('visibilitychange', onVisible);
}
function stopSync() {
  stopTimers();
  try { sync.channel?.unsubscribe(); } catch { }
  sync.channel = null; sync.busy = false; sync.pending = false;
  setSyncStatus('off');
}

/** クラウドの内容でこの端末を置き換える（手動） */
async function replaceFromCloud() {
  const box = await fetchCloud();
  if (!box) throw Error('クラウドに同期データがありません。');
  const remote = await readCloud(box);
  state.records = remote.records;
  state.deleted = remote.deleted;
  state.base = Object.fromEntries(remote.records.map(r => [r.id, r.updatedAt]));
  selected.clear();
  await save(true);
  setSyncStatus('ok', 'クラウドの記録をこの端末へ取り込みました。');
  render();
}

/* =======================================================================
   設定
   ======================================================================= */
function settings() {
  const c = getSyncConfig();
  layout(`<header class="page-header"><div><h1>設定・データ管理</h1>
    <p>記録はこの端末内に暗号化して保存され、クラウドへは暗号化済みのまま送られます。</p></div>
    <div class="header-actions">${syncBadge()}${lockBtn}</div></header>

    <section class="setting-card"><h2>PC・スマホ同期（Supabase）</h2>
    <p>ログインすると、記録の保存・編集・削除が自動でクラウドへ反映され、他の端末の変更も自動で取り込まれます。同じ出来事が両方の端末で編集されていた場合は、上書きの確認ダイアログを表示します。</p>
    <form id="sync-config" class="stack">
      <label>Project URL<input name="url" type="url" value="${esc(c.url || '')}" placeholder="https://xxxxx.supabase.co" required></label>
      <label>anon public key<input name="anonKey" type="password" value="${esc(c.anonKey || '')}" required></label>
      <label>メールアドレス<input name="email" type="email" value="${esc(c.email || '')}" required></label>
      <label>Supabaseパスワード<input name="password" type="password" autocomplete="current-password" required></label>
      <div class="actions"><button class="primary" type="submit">ログインして自動同期を開始</button>
      <button class="secondary" type="button" data-signup>アカウントを作成</button></div>
      <p data-sync-message class="hint" hidden></p></form>
    <div class="actions"><button class="secondary" data-sync-now>今すぐ同期</button>
      <button class="secondary" data-sync-down>クラウドの記録で置き換える</button>
      <button class="secondary" data-signout>ログアウト</button></div>
    <p class="hint">別の端末では、同じアプリ用パスコードと同じSupabaseアカウントを使ってください。「置き換える」はこの端末の記録を破棄してクラウド版を取り込みます。</p></section>

    <section class="setting-card"><h2>バックアップを作成</h2>
    <p>すべての記録をJSONファイルとして書き出します。暗号化されていないため、安全な場所に保管してください。</p>
    <button class="primary" data-backup>バックアップをエクスポート</button></section>

    <section class="setting-card"><h2>ロック</h2><p>すぐにロック画面へ切り替えます。</p>
    <button class="secondary" data-lock>今すぐロック</button></section>

    <section class="setting-card"><h2>すべての記録を削除</h2>
    <p>保存されている${state.records.length}件の記録をすべて削除します。同期が有効な場合、削除はクラウドにも反映されます。</p>
    <button class="danger" data-clear>すべて削除する</button></section>`);

  $('[data-backup]').onclick = backup;
  $('[data-clear]').onclick = async () => {
    if (prompt('確認のため「削除」と入力してください') !== '削除') return;
    const t = nowISO();
    state.records.forEach(r => state.deleted[r.id] = t);
    state.records = []; state.base = {}; selected.clear();
    await save(); render();
  };
  $('#sync-config').onsubmit = async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    localStorage.setItem(SYNC, JSON.stringify({ url: v.url.trim(), anonKey: v.anonKey.trim(), email: v.email.trim() }));
    supabaseClient = null;
    try {
      connectSync();
      const { error } = await supabaseClient.auth.signInWithPassword({ email: v.email, password: v.password });
      if (error) throw error;
      setSyncStatus('syncing', 'ログインしました。自動同期を開始します。');
      startSync();
    } catch (err) { setSyncStatus('error', err.message || '同期に失敗しました。'); }
  };
  $('[data-signup]').onclick = async () => {
    const v = Object.fromEntries(new FormData($('#sync-config')));
    localStorage.setItem(SYNC, JSON.stringify({ url: v.url.trim(), anonKey: v.anonKey.trim(), email: v.email.trim() }));
    supabaseClient = null;
    try {
      connectSync();
      const { error } = await supabaseClient.auth.signUp({ email: v.email, password: v.password });
      if (error) throw error;
      setSyncStatus('off', 'アカウントを作成しました。確認メールが届く設定の場合は、確認後にログインしてください。');
    } catch (err) { setSyncStatus('error', err.message || 'アカウント作成に失敗しました。'); }
  };
  $('[data-sync-down]').onclick = async () => {
    if (!confirm('この端末の記録を、クラウドの内容で置き換えますか？')) return;
    try { await replaceFromCloud(); } catch (err) { setSyncStatus('error', err.message || '取得に失敗しました。'); }
  };
  $('[data-signout]').onclick = async () => {
    try { await supabaseClient?.auth.signOut(); } catch { }
    stopSync();
    setSyncStatus('off', 'ログアウトしました。自動同期を停止しています。');
  };
}

function backup() {
  const a = document.createElement('a');
  const blob = new Blob([JSON.stringify({ app: 'こころの記録', version: 3, exportedAt: nowISO(), records: state.records }, null, 2)], { type: 'application/json' });
  a.href = URL.createObjectURL(blob);
  a.download = `kokoro-cbt-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* =======================================================================
   起動
   ======================================================================= */
function render() {
  if (page === 'home') home();
  else if (page === 'new') editor();
  else if (page === 'detail') detail();
  else if (page === 'guide') guide();
  else if (page === 'export') exportPage();
  else if (page === 'print') printPage();
  else settings();
}

if (!window.crypto?.subtle) {
  app.innerHTML = '<main class="auth-page"><section class="auth-card"><h1>対応していないブラウザです</h1><p>安全な暗号化機能を使えるブラウザで開いてください。</p></section></main>';
} else {
  localStorage.getItem(STORE) ? showUnlock() : showSetup();
}
