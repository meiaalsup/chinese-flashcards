/* ── Utilities ─────────────────────────────────────────────────────────── */

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/* ── TTS ───────────────────────────────────────────────────────────────── */

function speak(text) {
  if (!window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = 'zh-CN';
  utt.rate = 0.85;
  const voices = window.speechSynthesis.getVoices();
  const zh = voices.find(v => v.lang.startsWith('zh'));
  if (zh) utt.voice = zh;
  window.speechSynthesis.speak(utt);
}
window.speechSynthesis?.addEventListener('voiceschanged', () => window.speechSynthesis.getVoices());

/* ── Dictionary status ─────────────────────────────────────────────────── */

async function pollDictStatus() {
  try {
    const { dictReady } = await api('GET', '/api/status');
    const statusEl = $('dict-status');
    const lbl = statusEl.querySelector('.dict-label');
    if (dictReady) {
      statusEl.className = 'dict-status ready';
      lbl.textContent = 'Dictionary ready';
    } else {
      statusEl.className = 'dict-status loading';
      lbl.textContent = 'Loading dictionary…';
      setTimeout(pollDictStatus, 1500);
    }
  } catch {
    $('dict-status').className = 'dict-status error';
    $('dict-status').querySelector('.dict-label').textContent = 'Dictionary error';
  }
}

/* ── State ─────────────────────────────────────────────────────────────── */

let allCards  = [];
let allGroups = [];
let allTags   = [];           // all tag objects from /api/tags
let cardTagMap = new Map();   // cardId → [tag, ...]  (populated lazily per card)

// Study session state
let studyQueue     = [];
let studyIndex     = 0;
let studyCorrect   = 0;
let studyWrong     = 0;
let studyGroupId   = null;
let studyGroupName = '';
let studyDir       = 'zh-en';  // 'zh-en' | 'en-zh'
let isFlipped      = false;    // tracks current card flip state

/* ── Tab switching ─────────────────────────────────────────────────────── */

document.querySelectorAll('.nav-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'cards')  renderCards();
    if (btn.dataset.tab === 'groups') renderGroups();
    if (btn.dataset.tab === 'study')  renderStudyPicker();
  });
});

/* ── Generate tab ──────────────────────────────────────────────────────── */

let previewCards = [];

function loadGroupsIntoSelect(selectedId = null) {
  const select = $('gen-group');
  const prev = selectedId ?? select.value;
  const customs = allGroups.filter(g => !g.is_smart);
  select.innerHTML = '<option value="">— none —</option>';
  customs.forEach(g => {
    const o = document.createElement('option');
    o.value = g.id; o.textContent = g.name;
    select.appendChild(o);
  });
  const newOpt = document.createElement('option');
  newOpt.value = '__new__'; newOpt.textContent = '＋ Create new group…';
  select.appendChild(newOpt);
  if (prev) select.value = prev;
}

$('gen-group').addEventListener('change', () => {
  if ($('gen-group').value === '__new__') {
    $('gen-new-group-wrap').style.display = 'flex';
    $('gen-new-group-name').value = '';
    $('gen-new-group-name').focus();
  } else {
    $('gen-new-group-wrap').style.display = 'none';
  }
});

async function confirmNewGroup() {
  const name = $('gen-new-group-name').value.trim();
  if (!name) { $('gen-new-group-name').focus(); return; }
  try {
    const group = await api('POST', '/api/groups', { name, color: '#4f8ef7' });
    await refreshMeta();
    loadGroupsIntoSelect(group.id);
    $('gen-new-group-wrap').style.display = 'none';
  } catch (e) {
    alert('Error creating group: ' + e.message);
  }
}

$('gen-new-group-confirm').addEventListener('click', confirmNewGroup);
$('gen-new-group-cancel').addEventListener('click', () => {
  $('gen-new-group-wrap').style.display = 'none';
  $('gen-group').value = '';
});
$('gen-new-group-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmNewGroup();
  if (e.key === 'Escape') $('gen-new-group-cancel').click();
});

$('gen-btn').addEventListener('click', async () => {
  const text = $('gen-input').value.trim();
  if (!text) return;
  $('gen-btn').disabled = true;
  $('gen-btn').querySelector('span').textContent = 'Generating…';
  try {
    const groupId = $('gen-group').value || null;
    const { created } = await api('POST', '/api/generate', {
      text, groupId: groupId ? +groupId : null,
    });
    previewCards = created;
    renderPreview();
    $('gen-preview').style.display = 'block';
    $('gen-input').value = '';
    invalidateAllTagCache();
    await Promise.all([refreshCards(), refreshMeta()]);
    renderActiveTab();
  } catch (e) {
    alert('Error generating cards: ' + e.message);
  } finally {
    $('gen-btn').disabled = false;
    $('gen-btn').querySelector('span').textContent = 'Generate Cards';
  }
});

function renderPreview() {
  $('preview-count').textContent = previewCards.length;
  const container = $('preview-cards');
  container.innerHTML = '';

  previewCards.forEach((card, i) => {
    const row = el('div', 'preview-card');

    const makeInput = (val, placeholder, key) => {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.value = val || ''; inp.placeholder = placeholder;
      async function saveField(newVal) {
        newVal = newVal.trim();
        if (newVal === (card[key] || '')) return;
        try {
          const updated = await api('PUT', `/api/cards/${card.id}`, { [key]: newVal });
          card[key] = updated[key];
          if (key === 'chinese') {
            card.pinyin  = updated.pinyin;
            card.english = card.english || updated.english;
            const inputs = row.querySelectorAll('input');
            inputs[1].value = updated.pinyin  || '';
            if (!inputs[2].value) inputs[2].value = updated.english || '';
          }
        } catch (_) {}
      }
      inp.addEventListener('blur',   e => saveField(e.target.value));
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
      return inp;
    };

    row.appendChild(makeInput(card.chinese, 'Chinese', 'chinese'));
    row.appendChild(makeInput(card.pinyin,  'Pinyin',  'pinyin'));
    row.appendChild(makeInput(card.english, 'English', 'english'));

    const delBtn = el('button', 'preview-card-delete', '×');
    delBtn.title = 'Delete card';
    delBtn.addEventListener('click', async () => {
      await api('DELETE', `/api/cards/${card.id}`);
      previewCards.splice(i, 1);
      renderPreview();
      invalidateAllTagCache();
      await Promise.all([refreshCards(), refreshMeta()]);
      renderActiveTab();
    });
    row.appendChild(delBtn);
    container.appendChild(row);
  });
}

$('preview-edit-all').addEventListener('click', () => switchTab('cards'));

/* ── Cards tab ─────────────────────────────────────────────────────────── */

// Tag filter dropdown — populated after tags load
function populateTagFilter() {
  const sel = $('cards-tag-filter');
  const prev = sel.value;
  sel.innerHTML = '<option value="">All tags</option>';

  const levels = allTags.filter(t => t.type === 'level');
  const topics = allTags.filter(t => t.type === 'topic');

  if (levels.length) {
    const og = document.createElement('optgroup'); og.label = 'Level';
    levels.forEach(t => { const o = document.createElement('option'); o.value = t.id; o.textContent = `${t.emoji} ${t.name}`; og.appendChild(o); });
    sel.appendChild(og);
  }
  if (topics.length) {
    const og = document.createElement('optgroup'); og.label = 'Topic';
    topics.forEach(t => { const o = document.createElement('option'); o.value = t.id; o.textContent = `${t.emoji} ${t.name}`; og.appendChild(o); });
    sel.appendChild(og);
  }
  if (prev) sel.value = prev;
}

// cardId → tag list (fetched + cached)
const tagCache = new Map();
let tagsPrefetchToken = 0;

async function getCardTagsBulk(cardIds) {
  const ids = [...new Set(cardIds.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return {};
  const qs = encodeURIComponent(ids.join(','));
  return api('GET', `/api/cards/tags-bulk?ids=${qs}`);
}

async function getCardTags(cardId) {
  if (tagCache.has(cardId)) return tagCache.get(cardId);
  const tags = await api('GET', `/api/cards/${cardId}/tags`);
  tagCache.set(cardId, tags);
  return tags;
}

// Pre-fetch tags for all visible cards
async function prefetchTagsForCards(cardIds) {
  const uncached = cardIds.filter(id => !tagCache.has(id));
  if (!uncached.length) return;
  // Bulk fetch to avoid hundreds of per-card requests.
  for (let i = 0; i < uncached.length; i += 200) {
    const chunk = uncached.slice(i, i + 200);
    const byCardId = await getCardTagsBulk(chunk);
    chunk.forEach(id => tagCache.set(id, byCardId[id] || []));
  }
}

// Card IDs that match a tag filter (built from cached data)
function filterByTag(cards, tagId) {
  if (!tagId) return cards;
  const tid = parseInt(tagId);
  return cards.filter(c => {
    const tags = tagCache.get(c.id);
    return tags && tags.some(t => t.id === tid);
  });
}

async function renderCards(filter = '', tagId = '') {
  const container = $('cards-list');
  container.innerHTML = '';

  let cards = allCards;
  if (filter) {
    const q = filter.toLowerCase();
    cards = cards.filter(c =>
      c.chinese.includes(q) ||
      (c.pinyin  || '').toLowerCase().includes(q) ||
      (c.english || '').toLowerCase().includes(q)
    );
  }

  const myToken = ++tagsPrefetchToken;
  // Tag filter requires tag data, so we fetch before filtering.
  if (tagId) {
    if (cards.length) {
      await prefetchTagsForCards(cards.map(c => c.id));
      if (myToken !== tagsPrefetchToken) return; // stale render pass
    }
    cards = filterByTag(cards, tagId);
  }

  $('cards-count').textContent = `${cards.length} card${cards.length !== 1 ? 's' : ''}`;

  if (!cards.length) {
    container.innerHTML = '<div class="empty-state">No cards yet. Use the Generate tab to add some!</div>';
    return;
  }
  cards.forEach(card => container.appendChild(buildCardItem(card)));

  // For normal cards view (no tag filter), render immediately and fill tag chips after.
  if (!tagId && cards.length) {
    const uncached = cards.filter(c => !tagCache.has(c.id)).map(c => c.id);
    if (uncached.length) {
      prefetchTagsForCards(uncached).then(() => {
        if (myToken === tagsPrefetchToken) renderCards(filter, tagId);
      });
    }
  }
}

function buildCardItem(card) {
  const div = el('div', 'card-item');
  div.dataset.id = card.id;

  div.append(
    el('div', 'card-item-chinese', card.chinese || '—'),
    el('div', 'card-item-pinyin',  card.pinyin  || ''),
    el('div', 'card-item-english', card.english || 'no translation yet'),
  );

  if (card.stats?.total > 0) {
    const pct   = Math.round((card.stats.correct / card.stats.total) * 100);
    const stats = el('div', 'card-item-stats');
    stats.appendChild(el('span', `stat-pill ${pct >= 70 ? 'good' : pct < 40 ? 'bad' : ''}`,
      `${pct}% · ${card.stats.total} studied`));
    div.appendChild(stats);
  }

  // Tag chips (read from cache; prefetch runs before render).
  const tagRow = el('div', 'tag-row');
  div.appendChild(tagRow);
  const tags = tagCache.get(card.id) || [];
  tagRow.innerHTML = '';
  tags.forEach(t => {
    const chip = el('span', `tag-chip ${t.type}`, `${t.emoji} ${t.name}`);
    chip.style.setProperty('--tag-color', t.color);
    tagRow.appendChild(chip);
  });

  const actions = el('div', 'card-item-actions');
  const editBtn = el('button', 'card-action-btn', 'Edit');
  editBtn.addEventListener('click', e => { e.stopPropagation(); openEditCard(card); });

  const learnedBtn = el('button', `card-action-btn learned-toggle ${card.learned ? 'is-learned' : ''}`,
    card.learned ? '✓ Learned' : 'Mark learned');
  learnedBtn.title = card.learned ? 'Click to move back to active' : 'Mark as learned and hide from deck';
  learnedBtn.addEventListener('click', async e => {
    e.stopPropagation();
    const nowLearned = !card.learned;
    await api('PUT', `/api/cards/${card.id}/learned`, { learned: nowLearned });
    card.learned = nowLearned ? 1 : 0;
    learnedBtn.textContent = nowLearned ? '✓ Learned' : 'Mark learned';
    learnedBtn.classList.toggle('is-learned', nowLearned);
    learnedBtn.title = nowLearned ? 'Click to move back to active' : 'Mark as learned and hide from deck';
    await refreshCards();
    renderCards($('cards-search').value, $('cards-tag-filter').value);
  });

  const delBtn = el('button', 'card-action-btn del', 'Delete');
  delBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (confirm(`Delete "${card.chinese || card.english}"?`)) deleteCard(card.id);
  });
  actions.append(editBtn, learnedBtn, delBtn);
  div.appendChild(actions);

  div.addEventListener('click', () => speak(card.chinese));
  return div;
}

$('cards-search').addEventListener('input', e => { renderCards(e.target.value, $('cards-tag-filter').value); });
$('cards-tag-filter').addEventListener('change', e => { renderCards($('cards-search').value, e.target.value); });
$('add-card-btn').addEventListener('click', () => openEditCard(null));

function openEditCard(card) {
  $('modal-title').textContent = card ? 'Edit Card' : 'New Card';
  const body = $('modal-body');
  body.innerHTML = '';

  const makeField = (label, id, val, ph) => {
    const f = el('div', 'modal-field');
    const lbl = el('label', 'label', label); lbl.htmlFor = id;
    const inp = document.createElement('input');
    inp.type = 'text'; inp.id = id; inp.value = val || ''; inp.placeholder = ph || '';
    f.append(lbl, inp); return f;
  };

  body.append(
    makeField('Chinese', 'edit-chinese', card?.chinese, '你好'),
    makeField('Pinyin',  'edit-pinyin',  card?.pinyin,  'nǐ hǎo  (auto-filled)'),
    makeField('English', 'edit-english', card?.english, 'hello  (auto-filled)'),
  );

  $('edit-chinese').addEventListener('blur', async e => {
    const val = e.target.value.trim();
    if (!val) return;
    try {
      const tmp = await api('POST', '/api/cards', { chinese: val, english: '' });
      if (!$('edit-pinyin').value)  $('edit-pinyin').value  = tmp.pinyin  || '';
      if (!$('edit-english').value) $('edit-english').value = tmp.english || '';
      await api('DELETE', `/api/cards/${tmp.id}`);
    } catch (_) {}
  });

  // ── Topic tag checkboxes (only for existing cards) ──
  let selectedTopicIds = new Set();
  const topicSection = el('div', 'modal-field');
  const topicLbl = el('label', 'label', 'Categories');
  topicSection.appendChild(topicLbl);

  const topicGrid = el('div', 'topic-checkbox-grid');
  topicSection.appendChild(topicGrid);
  body.appendChild(topicSection);

  const topicTags = allTags.filter(t => t.type === 'topic');

  async function buildTopicCheckboxes() {
    topicGrid.innerHTML = '';
    let cardTopicIds = new Set();
    if (card) {
      const existing = tagCache.has(card.id)
        ? tagCache.get(card.id)
        : await api('GET', `/api/cards/${card.id}/tags`);
      tagCache.set(card.id, existing);
      cardTopicIds = new Set(existing.filter(t => t.type === 'topic').map(t => t.id));
    }
    selectedTopicIds = new Set(cardTopicIds);

    topicTags.forEach(tag => {
      const wrap = el('label', 'topic-checkbox-wrap');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = cardTopicIds.has(tag.id);
      cb.addEventListener('change', () => {
        if (cb.checked) selectedTopicIds.add(tag.id);
        else selectedTopicIds.delete(tag.id);
      });
      const chip = el('span', `tag-chip topic`, `${tag.emoji} ${tag.name}`);
      chip.style.setProperty('--tag-color', tag.color);
      wrap.append(cb, chip);
      topicGrid.appendChild(wrap);
    });
  }
  buildTopicCheckboxes();

  const footer = el('div', 'modal-footer');
  const cancelBtn = el('button', 'btn btn-ghost', 'Cancel');
  cancelBtn.addEventListener('click', closeModal);

  const saveBtn = el('button', 'btn btn-primary', card ? 'Save' : 'Create');
  saveBtn.addEventListener('click', async () => {
    const chinese = $('edit-chinese').value.trim();
    const pinyin  = $('edit-pinyin').value.trim();
    const english = $('edit-english').value.trim();
    if (!chinese && !english) { alert('Enter Chinese or English'); return; }
    try {
      let savedCard;
      if (card) {
        savedCard = await api('PUT', `/api/cards/${card.id}`, { chinese, pinyin, english });
      } else {
        savedCard = await api('POST', '/api/cards', { chinese, pinyin, english });
      }
      // Save topic tags if any checkboxes were touched
      if (selectedTopicIds.size > 0 || card) {
        await api('PUT', `/api/cards/${savedCard.id}/topics`, { tagIds: [...selectedTopicIds] });
      }
      // Keep add/edit fast: patch local state instead of reloading all cards.
      const idx = allCards.findIndex(c => c.id === savedCard.id);
      if (idx >= 0) {
        allCards[idx] = { ...allCards[idx], ...savedCard };
      } else {
        allCards.unshift(savedCard);
      }

      if (selectedTopicIds.size > 0) {
        const topicSet = new Set(selectedTopicIds);
        tagCache.set(
          savedCard.id,
          allTags.filter(t => t.type === 'topic' && topicSet.has(t.id))
        );
      } else if (!card) {
        tagCache.set(savedCard.id, []);
      } else {
        tagCache.delete(savedCard.id);
      }

      $('cards-count').textContent = `${allCards.length} card${allCards.length !== 1 ? 's' : ''}`;
      renderCards($('cards-search').value, $('cards-tag-filter').value);
      closeModal();

      // Local-first UI update, then silent reconcile with backend snapshot.
      setTimeout(() => {
        refreshCards()
          .then(() => renderCards($('cards-search').value, $('cards-tag-filter').value))
          .catch(() => {});
      }, 800);
    } catch (e) { alert('Error: ' + e.message); }
  });

  footer.append(cancelBtn, saveBtn);
  body.appendChild(footer);
  openModal();
}

async function deleteCard(id) {
  await api('DELETE', `/api/cards/${id}`);
  tagCache.delete(id);
  await refreshCards();
  renderCards($('cards-search').value);
}

/* ── Groups tab ────────────────────────────────────────────────────────── */

function renderGroups() {
  if (!allGroups.length && !allTags.length) {
    const hasExisting =
      $('smart-groups').children.length ||
      $('level-tags').children.length ||
      $('topic-tags').children.length ||
      $('custom-groups').children.length;
    if (hasExisting) return;

    $('smart-groups').innerHTML = '<div class="empty-state">Loading groups…</div>';
    $('level-tags').innerHTML = '';
    $('topic-tags').innerHTML = '';
    $('custom-groups').innerHTML = '';
    return;
  }

  $('smart-groups').innerHTML = '';
  $('level-tags').innerHTML   = '';
  $('topic-tags').innerHTML   = '';
  $('custom-groups').innerHTML = '';

  allGroups.filter(g => g.is_smart).forEach(g =>
    $('smart-groups').appendChild(buildGroupCard(g))
  );

  const levelTags = allTags.filter(t => t.type === 'level');
  const topicTags = allTags.filter(t => t.type === 'topic');

  levelTags.forEach(t => $('level-tags').appendChild(buildTagCard(t)));
  topicTags.forEach(t => $('topic-tags').appendChild(buildTagCard(t)));

  const customs = allGroups.filter(g => !g.is_smart);
  if (!customs.length) {
    $('custom-groups').innerHTML = '<div class="empty-state">No custom groups yet.</div>';
  } else {
    customs.forEach(g => $('custom-groups').appendChild(buildGroupCard(g)));
  }
}

function buildTagCard(tag) {
  const div = el('div', 'group-card');
  div.style.setProperty('--group-color', tag.color);

  const nameEl  = el('div', 'group-name', `${tag.emoji} ${tag.name}`);
  const countEl = el('div', 'group-count', `${tag.count} card${tag.count !== 1 ? 's' : ''}`);
  div.append(nameEl, countEl);

  div.addEventListener('click', async () => {
    const cards = await api('GET', `/api/tags/${tag.id}/cards`);
    openTagDetail(tag, cards);
  });
  return div;
}

async function openTagDetail(tag, cards) {
  $('modal-title').textContent = `${tag.emoji} ${tag.name}`;
  const body = $('modal-body');
  body.innerHTML = '';

  body.appendChild(el('p', 'section-sub', `${cards.length} card${cards.length !== 1 ? 's' : ''}`));

  if (cards.length) {
    const list = el('div', '');
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:12px;max-height:280px;overflow-y:auto';
    cards.forEach(card => {
      const row = el('div', '');
      row.style.cssText = 'padding:8px 10px;background:var(--bg3);border-radius:8px';
      row.innerHTML = `<span style="font-size:18px">${card.chinese || ''}</span> <span style="color:var(--accent-h);font-size:13px">${card.pinyin || ''}</span> <span style="color:var(--text-dim);font-size:13px">${card.english || ''}</span>`;
      list.appendChild(row);
    });
    body.appendChild(list);
  } else {
    body.appendChild(el('p', 'empty-state', 'No cards yet.'));
  }

  // Direction toggle + study button
  const dirWrap = el('div', '');
  dirWrap.style.cssText = 'margin-top:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap';
  const dirLabel = el('span', 'label', 'Study direction'); dirLabel.style.marginBottom = '0';
  const dirToggle = el('div', 'direction-toggle');
  const bZhEn = el('button', 'dir-btn' + (studyDir === 'zh-en' ? ' active' : ''), 'Chinese → English');
  bZhEn.dataset.dir = 'zh-en';
  const bEnZh = el('button', 'dir-btn' + (studyDir === 'en-zh' ? ' active' : ''), 'English → Chinese');
  bEnZh.dataset.dir = 'en-zh';
  [bZhEn, bEnZh].forEach(b => b.addEventListener('click', () => {
    [bZhEn, bEnZh].forEach(x => x.classList.remove('active'));
    b.classList.add('active'); studyDir = b.dataset.dir;
    document.querySelectorAll('.dir-btn').forEach(x => x.classList.toggle('active', x.dataset.dir === studyDir));
  }));
  dirToggle.append(bZhEn, bEnZh);
  dirWrap.append(dirLabel, dirToggle);
  body.appendChild(dirWrap);

  if (cards.length) {
    const footer = el('div', 'modal-footer');
    const studyBtn = el('button', 'btn btn-primary', 'Study →');
    studyBtn.addEventListener('click', () => {
      closeModal();
      startStudySession(`tag:${tag.id}`, `${tag.emoji} ${tag.name}`, cards);
    });
    footer.appendChild(studyBtn);
    body.appendChild(footer);
  }

  openModal();
}

function buildGroupCard(group) {
  const div = el('div', 'group-card');
  div.style.setProperty('--group-color', group.color);
  div.append(
    el('div', 'group-name',  group.name),
    el('div', 'group-count', `${group.count} card${group.count !== 1 ? 's' : ''}`),
  );
  if (group.is_smart) {
    div.appendChild(el('span', 'group-badge', 'Smart'));
  } else {
    const del = el('button', 'group-delete-btn', 'Delete');
    del.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Delete group "${group.name}"?`)) deleteGroup(group.id);
    });
    div.appendChild(del);
  }
  div.addEventListener('click', () => openGroupDetail(group));
  return div;
}

async function deleteGroup(id) {
  await api('DELETE', `/api/groups/${id}`);
  await refreshMeta();
  loadGroupsIntoSelect();
  renderGroups();
}

$('new-group-btn').addEventListener('click', () => {
  $('modal-title').textContent = 'New Group';
  const body = $('modal-body');
  body.innerHTML = '';

  const nameField = el('div', 'modal-field');
  const nameLbl = el('label', 'label', 'Group Name'); nameLbl.htmlFor = 'ng-name';
  const nameInp = document.createElement('input');
  nameInp.type = 'text'; nameInp.id = 'ng-name'; nameInp.placeholder = 'e.g. HSK Level 1';
  nameField.append(nameLbl, nameInp);

  const colorField = el('div', 'modal-field');
  const colorLbl = el('label', 'label', 'Color'); colorLbl.htmlFor = 'ng-color';
  const colorPicker = document.createElement('input');
  colorPicker.type = 'color'; colorPicker.id = 'ng-color'; colorPicker.value = '#6366f1';
  colorPicker.style.cssText = 'width:48px;height:36px;padding:2px;border-radius:6px;cursor:pointer;background:var(--bg3);border:1px solid var(--border)';
  colorField.append(colorLbl, colorPicker);

  body.append(nameField, colorField);

  const footer = el('div', 'modal-footer');
  const cancelBtn = el('button', 'btn btn-ghost', 'Cancel');
  cancelBtn.addEventListener('click', closeModal);
  const saveBtn = el('button', 'btn btn-primary', 'Create');
  saveBtn.addEventListener('click', async () => {
    const name = nameInp.value.trim();
    if (!name) { alert('Enter a group name'); return; }
    await api('POST', '/api/groups', { name, color: colorPicker.value });
    await refreshMeta();
    renderGroups();
    loadGroupsIntoSelect();
    closeModal();
  });
  footer.append(cancelBtn, saveBtn);
  body.appendChild(footer);
  openModal();
});

async function openGroupDetail(group) {
  $('modal-title').textContent = group.name;
  const body = $('modal-body');
  body.innerHTML = 'Loading…';
  openModal();

  const cards = await api('GET', `/api/groups/${group.id}/cards`);
  body.innerHTML = '';

  const infoLine = el('p', 'section-sub', `${cards.length} card${cards.length !== 1 ? 's' : ''} in this group`);
  body.appendChild(infoLine);

  if (cards.length) {
    const list = el('div', '');
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:12px;max-height:280px;overflow-y:auto';
    cards.forEach(card => {
      const row = el('div', '');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;background:var(--bg3);border-radius:8px;flex-shrink:0';
      const left = el('div', '');
      left.innerHTML = `<span style="font-size:18px">${card.chinese || ''}</span> <span style="color:var(--accent-h);font-size:13px">${card.pinyin || ''}</span> <span style="color:var(--text-dim);font-size:13px">${card.english || ''}</span>`;
      row.appendChild(left);
      if (!group.is_smart) {
        const rem = el('button', 'btn btn-ghost btn-sm', 'Remove');
        rem.addEventListener('click', async () => {
          await api('DELETE', `/api/groups/${group.id}/cards/${card.id}`);
          row.remove();
          await refreshMeta();
          renderGroups();
          loadGroupsIntoSelect();
        });
        row.appendChild(rem);
      }
      list.appendChild(row);
    });
    body.appendChild(list);
  } else {
    body.appendChild(el('p', 'empty-state', 'No cards yet.'));
  }

  // Direction toggle
  const dirWrap = el('div', '');
  dirWrap.style.cssText = 'margin-top:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap';
  const dirLabel = el('span', 'label', 'Study direction');
  dirLabel.style.marginBottom = '0';

  const dirToggle = el('div', 'direction-toggle');
  const btnZhEn = el('button', 'dir-btn' + (studyDir === 'zh-en' ? ' active' : ''), 'Chinese → English');
  btnZhEn.dataset.dir = 'zh-en';
  const btnEnZh = el('button', 'dir-btn' + (studyDir === 'en-zh' ? ' active' : ''), 'English → Chinese');
  btnEnZh.dataset.dir = 'en-zh';

  [btnZhEn, btnEnZh].forEach(b => b.addEventListener('click', () => {
    [btnZhEn, btnEnZh].forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    studyDir = b.dataset.dir;
    // also sync global toggle
    document.querySelectorAll('.dir-btn').forEach(x =>
      x.classList.toggle('active', x.dataset.dir === studyDir)
    );
  }));

  dirToggle.append(btnZhEn, btnEnZh);
  dirWrap.append(dirLabel, dirToggle);
  body.appendChild(dirWrap);

  // Footer
  const footer = el('div', 'modal-footer');
  if (!group.is_smart) {
    const addBtn = el('button', 'btn btn-ghost', 'Add cards');
    addBtn.addEventListener('click', () => openAddCardsToGroup(group));
    footer.appendChild(addBtn);
  }

  if (cards.length) {
    const studyBtn = el('button', 'btn btn-primary', 'Study →');
    studyBtn.addEventListener('click', () => {
      closeModal();
      startStudySession(group.id, group.name, cards);
    });
    footer.appendChild(studyBtn);
  }

  body.appendChild(footer);
}

async function openAddCardsToGroup(group) {
  $('modal-title').textContent = `Add to "${group.name}"`;
  const body = $('modal-body');
  body.innerHTML = '';

  const groupCards   = await api('GET', `/api/groups/${group.id}/cards`);
  const groupCardIds = new Set(groupCards.map(c => c.id));
  const selected     = new Set();

  const searchInp = document.createElement('input');
  searchInp.type = 'search'; searchInp.placeholder = 'Filter…';
  searchInp.style.marginBottom = '12px';
  body.appendChild(searchInp);

  const listWrap = el('div', '');
  listWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:360px;overflow-y:auto';
  body.appendChild(listWrap);

  function renderAddList(filter) {
    listWrap.innerHTML = '';
    const visible = allCards.filter(c => {
      if (groupCardIds.has(c.id)) return false;
      if (!filter) return true;
      const q = filter.toLowerCase();
      return c.chinese.includes(q) || (c.english || '').toLowerCase().includes(q);
    });
    if (!visible.length) { listWrap.appendChild(el('div', 'empty-state', 'No cards to add.')); return; }
    visible.forEach(card => {
      const row = el('div', '');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;transition:background 0.1s';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = selected.has(card.id);
      const lbl = el('span', '', `${card.chinese || ''} ${card.pinyin ? '· ' + card.pinyin : ''} ${card.english ? '— ' + card.english : ''}`);
      lbl.style.fontSize = '14px';
      row.append(cb, lbl);
      row.addEventListener('click', () => {
        cb.checked = !cb.checked;
        if (cb.checked) selected.add(card.id); else selected.delete(card.id);
        row.style.background = cb.checked ? 'var(--bg3)' : '';
      });
      listWrap.appendChild(row);
    });
  }

  renderAddList('');
  searchInp.addEventListener('input', e => renderAddList(e.target.value));

  const footer = el('div', 'modal-footer');
  const backBtn = el('button', 'btn btn-ghost', 'Back');
  backBtn.addEventListener('click', () => openGroupDetail(group));
  const addBtn = el('button', 'btn btn-primary', 'Add selected');
  addBtn.addEventListener('click', async () => {
    if (!selected.size) { alert('Select at least one card'); return; }
    await api('POST', `/api/groups/${group.id}/cards`, { cardIds: [...selected] });
    await refreshMeta();
    openGroupDetail(group);
  });
  footer.append(backBtn, addBtn);
  body.appendChild(footer);
}

/* ── Study tab ─────────────────────────────────────────────────────────── */

// Sync the global direction toggle buttons
document.querySelectorAll('.dir-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    studyDir = btn.dataset.dir;
  });
});

async function renderStudyPicker() {
  $('study-picker').style.display  = '';
  $('study-session').style.display = 'none';

  const container = $('study-groups-list');
  container.innerHTML = '';

  allGroups.forEach(g => {
    const div = el('div', 'group-card study-group-card');
    div.style.setProperty('--group-color', g.color);
    div.append(
      el('div', 'group-name',  g.name),
      el('div', 'group-count', `${g.count} card${g.count !== 1 ? 's' : ''}`),
      el('button', 'btn btn-sm study-now-btn', 'Study now →'),
    );
    div.addEventListener('click', async () => {
      const cards = await api('GET', `/api/groups/${g.id}/cards`);
      if (!cards.length) { alert('This group has no cards yet.'); return; }
      startStudySession(g.id, g.name, cards);
    });
    container.appendChild(div);
  });
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startStudySession(groupId, groupName, cards) {
  studyGroupId   = groupId;
  studyGroupName = groupName;
  studyQueue     = shuffle(cards.filter(c => c.chinese || c.english));
  studyIndex = studyCorrect = studyWrong = 0;
  isFlipped  = false;

  $('session-title').textContent   = groupName;
  $('study-picker').style.display  = 'none';
  $('study-session').style.display = '';
  $('session-done').style.display  = 'none';
  $('flashcard-wrap').style.display = '';
  $('answer-btns').style.display   = 'none';

  switchTab('study');
  applyDirection();
  showCard();
}

function applyDirection() {
  const zh = studyDir === 'zh-en';
  $('front-zh').style.display = zh ? '' : 'none';
  $('front-en').style.display = zh ? 'none' : '';
  $('back-zh').style.display  = zh ? '' : 'none';
  $('back-en').style.display  = zh ? 'none' : '';
}

function showCard() {
  const card = studyQueue[studyIndex];
  const total = studyQueue.length;

  $('session-progress-text').textContent = `${studyIndex + 1} / ${total}`;
  $('progress-bar').style.width = `${(studyIndex / total) * 100}%`;

  // Un-flip without animation for instant card change
  const fc = $('flashcard');
  fc.style.transition = 'none';
  fc.classList.remove('flipped');
  isFlipped = false;

  // Force reflow so the no-transition applies immediately, then restore animation
  fc.getBoundingClientRect();
  fc.style.transition = '';

  $('answer-btns').style.display = 'none';

  if (studyDir === 'zh-en') {
    $('card-chinese').textContent      = card.chinese || '';
    $('card-pinyin').textContent       = card.pinyin  || '';
    $('card-english').textContent      = card.english || '(no translation)';
    $('card-chinese-back').textContent = card.chinese || '';
    $('card-pinyin-back').textContent  = card.pinyin  || '';
  } else {
    $('card-english-front').textContent = card.english || card.chinese || '';
    $('card-chinese-back2').textContent = card.chinese || '';
    $('card-pinyin-back2').textContent  = card.pinyin  || '';
  }
}

// ── Flashcard flip — single listener, never replaced ──────────────────

$('flashcard').addEventListener('click', () => {
  if (isFlipped) return; // already showing answer
  isFlipped = true;
  $('flashcard').classList.add('flipped');
  $('answer-btns').style.display = 'flex';
});

// ── Speak buttons ─────────────────────────────────────────────────────

function flashSpeak(id, text) {
  speak(text);
  const btn = $(id);
  btn.classList.add('speaking');
  setTimeout(() => btn.classList.remove('speaking'), 1200);
}

$('speak-btn').addEventListener('click', e => {
  e.stopPropagation();
  flashSpeak('speak-btn', $('card-chinese').textContent);
});
$('speak-btn-back').addEventListener('click', e => {
  e.stopPropagation();
  flashSpeak('speak-btn-back', $('card-chinese-back').textContent);
});
$('speak-btn-back2').addEventListener('click', e => {
  e.stopPropagation();
  flashSpeak('speak-btn-back2', $('card-chinese-back2').textContent);
});

// ── Answer buttons ────────────────────────────────────────────────────

async function recordAnswer(correct) {
  const card = studyQueue[studyIndex];
  try {
    await api('POST', '/api/study', { cardId: card.id, correct });
  } catch (e) {
    console.error('study log error:', e);
    // don't block progression on network error
  }
  if (correct) studyCorrect++; else studyWrong++;
  studyIndex++;
  if (studyIndex >= studyQueue.length) {
    endSession();
  } else {
    showCard();
  }
}

$('btn-right').addEventListener('click', () => recordAnswer(true));
$('btn-wrong').addEventListener('click', () => recordAnswer(false));

$('btn-learned').addEventListener('click', async () => {
  const card = studyQueue[studyIndex];
  try { await api('PUT', `/api/cards/${card.id}/learned`, { learned: true }); } catch (_) {}
  // Remove from queue and advance without counting as right/wrong
  studyQueue.splice(studyIndex, 1);
  if (studyQueue.length === 0 || studyIndex >= studyQueue.length) {
    endSession();
  } else {
    showCard();
  }
});

function endSession() {
  $('flashcard-wrap').style.display = 'none';
  $('answer-btns').style.display    = 'none';
  $('session-done').style.display   = 'block';
  $('progress-bar').style.width     = '100%';

  const total = studyCorrect + studyWrong;
  const pct   = total ? Math.round((studyCorrect / total) * 100) : 0;

  $('done-stats').innerHTML = `
    <div><div class="done-stat-label">Correct</div>
    <div class="done-stat-val good">${studyCorrect}</div></div>
    <div><div class="done-stat-label">Incorrect</div>
    <div class="done-stat-val bad">${studyWrong}</div></div>
    <div><div class="done-stat-label">Accuracy</div>
    <div class="done-stat-val ${pct >= 70 ? 'good' : 'bad'}">${pct}%</div></div>
    <div><div class="done-stat-label">Reviewed</div>
    <div class="done-stat-val">${total}</div></div>
  `;
  refreshCards().catch(console.error);
}

$('session-back').addEventListener('click', () => {
  $('study-picker').style.display  = '';
  $('study-session').style.display = 'none';
  renderStudyPicker();
});
$('done-back').addEventListener('click', () => {
  $('study-picker').style.display  = '';
  $('study-session').style.display = 'none';
  renderStudyPicker();
});
$('done-retry').addEventListener('click', async () => {
  let cards;
  if (typeof studyGroupId === 'string' && studyGroupId.startsWith('tag:')) {
    const tagId = studyGroupId.slice(4);
    cards = await api('GET', `/api/tags/${tagId}/cards`);
  } else {
    cards = await api('GET', `/api/groups/${studyGroupId}/cards`);
  }
  startStudySession(studyGroupId, studyGroupName, cards);
});

/* ── Modal helpers ──────────────────────────────────────────────────────── */

function openModal()  { $('modal-overlay').style.display = 'flex'; }
function closeModal() { $('modal-overlay').style.display = 'none'; }
$('modal-close').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', e => {
  if (e.target === $('modal-overlay')) closeModal();
});

/* ── Navigation helper ──────────────────────────────────────────────────── */

function switchTab(name) {
  document.querySelectorAll('.nav-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name)
  );
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.id === `tab-${name}`)
  );
}

/* ── Bootstrap ──────────────────────────────────────────────────────────── */

function invalidateAllTagCache() {
  tagCache.clear();
  tagsPrefetchToken++;
}

async function refreshCards() {
  allCards = await api('GET', '/api/cards');
}

async function refreshMeta() {
  [allGroups, allTags] = await Promise.all([
    api('GET', '/api/groups'),
    api('GET', '/api/tags'),
  ]);
}

function renderActiveTab() {
  const activeBtn = document.querySelector('.nav-tab.active');
  const tab = activeBtn?.dataset?.tab;
  if (tab === 'cards') renderCards($('cards-search').value, $('cards-tag-filter').value);
  if (tab === 'groups') renderGroups();
  if (tab === 'study') renderStudyPicker();
}

async function init() {
  $('cards-list').innerHTML = '<div class="empty-state">Loading cards…</div>';
  await refreshCards();
  renderCards();
  $('cards-count').textContent = `${allCards.length} card${allCards.length !== 1 ? 's' : ''}`;
  pollDictStatus();

  // Load groups/tags after cards so cards page appears first.
  await refreshMeta();
  loadGroupsIntoSelect();
  populateTagFilter();
  renderActiveTab();
}

init().catch(console.error);
