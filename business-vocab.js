// Business Vocabulary: the screen. Rules live in business-vocab-core.js, the 100 words in business-vocab-words.js.
import {
  WORDS, CATEGORIES, MODES, MASTERED, wordById, normalizeProfile, progressOf, rankFor, reviewIds, recordAnswer, boxOf,
  makeDeck, choicesFor, blankSentence, scoreRound, finishSession, verdict
} from './business-vocab-core.js';

const STORE = 'sg-business-vocab-v1';
const $ = selector => document.querySelector(selector);
const esc = text => String(text).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const categoryOf = id => CATEGORIES.find(c => c.id === id);
const modeOf = id => MODES.find(m => m.id === id);
const POS = { noun: 'noun', verb: 'verb', adjective: 'adjective' };

function load() { try { return normalizeProfile(JSON.parse(localStorage.getItem(STORE))); } catch { return normalizeProfile(null); } }
function save() { try { localStorage.setItem(STORE, JSON.stringify(profile)); } catch { /* private mode: the game still works */ } }

let profile = load();
let view = 'lobby';                    // lobby | play | results | bank
let session = null;                    // { mode, category, deck, index, answers, picked, flipped, choices }
let result = null;
let bank = { query: '', category: 'all', open: null };

// ---------------------------------------------------------------- hearing a word
function say(text) {
  try {
    const synth = window.speechSynthesis; if (!synth) return;
    synth.cancel();
    const line = new SpeechSynthesisUtterance(text);
    line.lang = 'en-US'; line.rate = 0.92;
    const voice = synth.getVoices().find(v => /^en[-_](US|GB)/i.test(v.lang));
    if (voice) line.voice = voice;
    synth.speak(line);
  } catch { /* hearing it is a bonus */ }
}
const sayButton = word => window.speechSynthesis ? `<button type="button" class="bv-say" data-act="say" data-id="${word.id}" aria-label="Hear how to say ${esc(word.word)}">🔊</button>` : '';

// ---------------------------------------------------------------- pieces
function ring(mastered, total) {
  const r = 46, c = 2 * Math.PI * r, part = total ? mastered / total : 0;
  return `<svg class="bv-ring" viewBox="0 0 110 110" aria-hidden="true">
    <circle cx="55" cy="55" r="${r}" class="bv-ring-track"/>
    <circle cx="55" cy="55" r="${r}" class="bv-ring-fill" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - part)).toFixed(1)}"/>
  </svg>`;
}
const dots = id => { const box = boxOf(profile, id); return `<span class="bv-dots" aria-label="${box >= MASTERED ? 'Mastered' : `${box} of ${MASTERED} right in a row`}">${Array.from({ length: MASTERED }, (_, i) => `<i class="${i < box ? 'on' : ''}"></i>`).join('')}</span>`; };
const highlight = word => { const b = blankSentence(word); return b ? `${esc(b.before)}<mark>${esc(b.answer)}</mark>${esc(b.after)}` : esc(word.example); };

function topicChips(selected, act) {
  const chip = (id, label, extra = '') => `<button type="button" class="bv-chip ${selected === id ? 'on' : ''}" data-act="${act}" data-cat="${id}" aria-pressed="${selected === id}">${label}${extra}</button>`;
  return `<div class="bv-chips" role="group" aria-label="Topic">${chip('all', 'All topics', ` <small>${progressOf(profile).mastered}/100</small>`)}${CATEGORIES.map(c => chip(c.id, `${c.icon} ${esc(c.name)}`, ` <small>${progressOf(profile, c.id).mastered}/20</small>`)).join('')}</div>`;
}

// ---------------------------------------------------------------- views
function lobbyHtml() {
  const all = progressOf(profile), rank = rankFor(all.mastered), category = profile.settings.category, review = reviewIds(profile).length;
  const modeCard = mode => {
    const off = mode.id === 'review' && !review;
    const note = mode.id === 'review' ? (review ? `${review} word${review === 1 ? '' : 's'} to review` : 'Nothing to review yet') : '';
    return `<button type="button" class="bv-mode ${off ? 'off' : ''}" data-act="start" data-mode="${mode.id}" ${off ? 'disabled' : ''}>
      <span class="bv-mode-icon" aria-hidden="true">${mode.icon}</span><b>${mode.name}</b><span>${mode.blurb}</span>${note ? `<em>${note}</em>` : ''}</button>`;
  };
  return `<div class="bv-in">
    <header class="bv-hero"><div class="bv-badge" aria-hidden="true">💼</div><h2>Business Vocabulary</h2>
      <p>100 words that make you sound clear, sharp and professional at work. Learn them, then use them out loud.</p></header>
    <section class="bv-card bv-progress" aria-label="Your progress">
      <div class="bv-ring-wrap">${ring(all.mastered, all.total)}<div class="bv-ring-text"><b>${all.mastered}</b><span>of 100 mastered</span></div></div>
      <div class="bv-rank">
        <div class="bv-rank-name"><span aria-hidden="true">${rank.current.icon}</span> ${esc(rank.current.name)}</div>
        <p>${rank.next ? `Master ${rank.toNext} more word${rank.toNext === 1 ? '' : 's'} to become <b>${esc(rank.next.name)}</b>.` : 'You have mastered every word. Keep them fresh.'}</p>
        <div class="bv-bar"><i style="width:${Math.round(rank.progress * 100)}%"></i></div>
        <div class="bv-mini"><span><b>${all.learning}</b> learning</span><span><b>${all.fresh}</b> new</span><span><b>${profile.xp}</b> XP</span></div>
      </div>
    </section>
    <h3 class="bv-h">Choose a topic</h3>
    ${topicChips(category, 'topic')}
    <h3 class="bv-h">Choose a game</h3>
    <div class="bv-modes">${MODES.map(modeCard).join('')}</div>
    <button type="button" class="bv-card bv-bank-link" data-act="bank"><span aria-hidden="true">📖</span><div><b>Word bank</b><small>Browse and search all 100 words with their meanings.</small></div><i aria-hidden="true">→</i></button>
    <p class="bv-fine">A word is mastered after three right answers in a row. A wrong answer sends it to Review Mistakes.</p>
  </div>`;
}

function playHtml() {
  const s = session, word = s.deck[s.index], total = s.deck.length, answered = s.picked !== null;
  const streak = (() => { let n = 0; for (let i = s.answers.length - 1; i >= 0 && s.answers[i].correct; i--) n++; return n; })();
  const top = `<div class="bv-top"><span class="bv-top-mode">${modeOf(s.mode).icon} ${modeOf(s.mode).name}</span><span class="bv-top-count">${s.index + 1} / ${total}</span>${streak >= 2 ? `<span class="bv-streak">🔥 ${streak}</span>` : ''}</div>
    <div class="bv-bar thin" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${s.index}"><i style="width:${(s.index / total) * 100}%"></i></div>`;
  const reveal = `<div class="bv-reveal" role="status">
      <div class="bv-reveal-head"><b>${esc(word.word)}</b><span class="bv-pos">${POS[word.pos]}</span>${sayButton(word)}</div>
      <p class="bv-def">${esc(word.definition)}</p>
      <p class="bv-example">“${highlight(word)}”</p>
      <p class="bv-speak">🎤 <b>Say it out loud:</b> use “${esc(word.word)}” in a sentence about your own work.</p>
    </div>`;
  if (s.mode === 'learn') {
    const cat = categoryOf(word.category);
    return `<div class="bv-in">${top}
      <div class="bv-flash ${s.flipped ? 'flipped' : ''}">
        <span class="bv-tag">${cat.icon} ${esc(cat.name)}</span>
        <div class="bv-flash-word">${esc(word.word)}</div><span class="bv-pos">${POS[word.pos]}</span>${sayButton(word)}
        ${s.flipped ? `<div class="bv-flash-back">${reveal}</div>` : `<button type="button" class="bv-primary" data-act="flip">Show the meaning</button><p class="bv-fine">Think of what it means first, then check.</p>`}
      </div>
      ${s.flipped ? `<div class="bv-pair"><button type="button" class="bv-ghost" data-act="rate" data-known="0">Still learning</button><button type="button" class="bv-primary" data-act="rate" data-known="1">I know it ✓</button></div>` : ''}
    </div>`;
  }
  const question = s.mode === 'gap'
    ? (() => { const b = blankSentence(word); return `<span class="bv-q-label">Fill the gap</span><p class="bv-q-text sentence">${esc(b.before)}<span class="bv-blank">${answered ? esc(b.answer) : '_______'}</span>${esc(b.after)}</p>`; })()
    : `<span class="bv-q-label">Which ${POS[word.pos]} means…</span><p class="bv-q-text">${esc(word.definition)}</p>`;
  const option = (choice, i) => {
    const state = !answered ? '' : choice.id === word.id ? 'right' : choice.id === s.picked ? 'wrong' : 'dim';
    return `<button type="button" class="bv-option ${state}" data-act="pick" data-id="${choice.id}" ${answered ? 'disabled' : ''}><kbd>${i + 1}</kbd>${esc(choice.word)}</button>`;
  };
  return `<div class="bv-in">${top}
    <div class="bv-q">${question}</div>
    <div class="bv-options">${s.choices.map(option).join('')}</div>
    ${answered ? `<p class="bv-verdict ${s.picked === word.id ? 'right' : 'wrong'}">${s.picked === word.id ? '✓ Correct' : `✗ The answer is “${esc(word.word)}”`}</p>${reveal}
      <button type="button" class="bv-primary wide" data-act="next">${s.index + 1 < total ? 'Next word →' : 'See results'}</button>` : ''}
  </div>`;
}

function resultsHtml() {
  const r = result, all = progressOf(profile), rank = rankFor(all.mastered);
  const missed = r.answers.filter(a => !a.correct).length;
  const row = a => { const word = wordById(a.id); return `<li class="${a.correct ? 'ok' : 'no'}"><span class="bv-mark" aria-label="${a.correct ? 'Right' : 'Missed'}">${a.correct ? '✓' : '✗'}</span><div><b>${esc(word.word)}</b> <span class="bv-pos">${POS[word.pos]}</span><p>${esc(word.definition)}</p></div>${dots(word.id)}</li>`; };
  const learn = r.mode === 'learn';
  return `<div class="bv-in">
    <header class="bv-hero small"><h2>${learn ? 'Flashcards done' : `${r.score.correct} / ${r.score.total}`}</h2>
      ${learn ? `<p>You knew ${r.score.correct} of ${r.score.total}. The rest will come back until they stick.</p>` : `<div class="bv-stars" aria-label="${r.score.stars} of 3 stars">${[0, 1, 2].map(i => `<span class="${i < r.score.stars ? 'on' : ''}">★</span>`).join('')}</div><p>${esc(verdict(r.score))}</p>`}</header>
    <div class="bv-card bv-summary"><div><b>+${r.score.xp}</b><span>XP</span></div><div><b>${r.score.bestStreak}</b><span>Best streak</span></div><div><b>${all.mastered}</b><span>Mastered</span></div></div>
    <p class="bv-rank-line"><span aria-hidden="true">${rank.current.icon}</span> ${esc(rank.current.name)}${rank.next ? ` · ${rank.toNext} to ${esc(rank.next.name)}` : ''}</p>
    <h3 class="bv-h">The words in this round</h3>
    <ul class="bv-list">${r.answers.map(row).join('')}</ul>
    <div class="bv-pair">${missed && !learn ? `<button type="button" class="bv-ghost" data-act="start" data-mode="review">Review mistakes</button>` : `<button type="button" class="bv-ghost" data-act="home">All games</button>`}
      <button type="button" class="bv-primary" data-act="start" data-mode="${r.mode}">Play again</button></div>
  </div>`;
}

function bankHtml() {
  const q = bank.query.trim().toLowerCase();
  const list = WORDS.filter(w => (bank.category === 'all' || w.category === bank.category) && (!q || w.word.toLowerCase().includes(q) || w.definition.toLowerCase().includes(q)));
  const item = w => {
    const open = bank.open === w.id;
    return `<li class="${open ? 'open' : ''}"><button type="button" class="bv-row" data-act="open" data-id="${w.id}" aria-expanded="${open}"><b>${esc(w.word)}</b><span class="bv-pos">${POS[w.pos]}</span>${dots(w.id)}</button>
      ${open ? `<div class="bv-row-more"><p class="bv-def">${esc(w.definition)}</p><p class="bv-example">“${highlight(w)}”</p>${sayButton(w)}</div>` : ''}</li>`;
  };
  return `<div class="bv-in">
    <header class="bv-hero small"><h2>Word bank</h2><p>All 100 words. Tap a word to see what it means and how to use it.</p></header>
    <label class="bv-search"><span aria-hidden="true">🔎</span><input type="search" id="bvSearch" placeholder="Search words or meanings" value="${esc(bank.query)}" aria-label="Search words or meanings"></label>
    ${topicChips(bank.category, 'bank-topic')}
    <p class="bv-fine">${list.length} word${list.length === 1 ? '' : 's'}</p>
    <ul class="bv-bank">${list.map(item).join('') || '<li class="bv-empty">No words match that search.</li>'}</ul>
  </div>`;
}

function paint(focus) {
  const root = $('#bizVocabRoot'); if (!root) return;
  root.innerHTML = view === 'play' ? playHtml() : view === 'results' ? resultsHtml() : view === 'bank' ? bankHtml() : lobbyHtml();
  if (focus) root.querySelector(focus)?.focus({ preventScroll: true });
}
const toTop = () => { const page = $('#bizVocabPage'); if (page && page.getBoundingClientRect().top < 0) page.scrollIntoView({ block: 'start' }); };

// ---------------------------------------------------------------- actions
function start(mode) {
  const category = profile.settings.category;
  const deck = makeDeck(profile, { mode, category });
  if (!deck.length) { view = 'lobby'; paint(); return; }          // e.g. "Review mistakes" after every mistake has been fixed
  session = { mode, category, deck, index: 0, answers: [], picked: null, flipped: false, choices: [] };
  prepare(); view = 'play'; paint(); toTop();
}
function prepare() { const word = session.deck[session.index]; session.picked = null; session.flipped = false; session.choices = session.mode === 'learn' ? [] : choicesFor(word, session.mode === 'review' ? 'meaning' : session.mode); }
function answer(correct) {
  const word = session.deck[session.index];
  session.answers.push({ id: word.id, correct });
  profile = recordAnswer(profile, word.id, correct); save();
}
function next() {
  if (session.index + 1 < session.deck.length) { session.index++; prepare(); paint('.bv-option, [data-act="flip"]'); return; }
  const score = scoreRound(session.answers);
  profile = finishSession(profile, score); save();
  result = { mode: session.mode, score, answers: session.answers };
  session = null; view = 'results'; paint(); toTop();
}

function onClick(event) {
  const target = event.target.closest('[data-act]'); if (!target || target.disabled) return;
  const act = target.dataset.act;
  if (act === 'topic') { profile.settings.category = target.dataset.cat; save(); paint(); }
  else if (act === 'start') start(target.dataset.mode);
  else if (act === 'bank') { view = 'bank'; paint(); toTop(); }
  else if (act === 'home') { view = 'lobby'; paint(); toTop(); }
  else if (act === 'bank-topic') { bank.category = target.dataset.cat; bank.open = null; paint(); }
  else if (act === 'open') { bank.open = bank.open === target.dataset.id ? null : target.dataset.id; paint(); }
  else if (act === 'say') say(wordById(target.dataset.id)?.word || '');
  else if (act === 'flip') { session.flipped = true; paint('[data-act="rate"][data-known="1"]'); }
  else if (act === 'rate') { answer(target.dataset.known === '1'); next(); }
  else if (act === 'pick') { if (session.picked !== null) return; session.picked = target.dataset.id; answer(session.picked === session.deck[session.index].id); paint('[data-act="next"]'); }
  else if (act === 'next') next();
}
function onInput(event) {
  if (event.target.id !== 'bvSearch') return;
  bank.query = event.target.value; bank.open = null;
  const at = event.target.selectionStart; paint();
  const input = $('#bvSearch'); input?.focus(); input?.setSelectionRange(at, at);
}
function onKey(event) {
  if (!$('#bizVocabPage')?.classList.contains('active') || view !== 'play' || event.target.closest?.('input, textarea')) return;
  if (session.mode !== 'learn' && session.picked === null && /^[1-4]$/.test(event.key)) $(`#bizVocabRoot .bv-option:nth-child(${event.key})`)?.click();
}

function mountStyles() {
  if ($('#bizVocabCss')) return;
  const link = document.createElement('link');
  link.id = 'bizVocabCss'; link.rel = 'stylesheet'; link.href = new URL('./business-vocab.css', import.meta.url).href;
  document.head.append(link);
}
function mount() {
  const root = $('#bizVocabRoot'); if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  mountStyles();
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  document.addEventListener('keydown', onKey);
  paint();
}

window.BusinessVocab = {
  // One step back: from a game, the results or the word bank to the game menu. Returns true if it handled it.
  back() { if (view === 'lobby') return false; session = null; view = 'lobby'; paint(); toTop(); return true; },
  render() { profile = load(); session = null; view = 'lobby'; paint(); },
  stop() { session = null; view = 'lobby'; try { window.speechSynthesis?.cancel(); } catch { /* nothing playing */ } }
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
