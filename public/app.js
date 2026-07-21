const currentTimestamp = document.getElementById('current-timestamp');
const entryTitle = document.getElementById('entry-title');
const entryContent = document.getElementById('entry-content');
const saveEntryButton = document.getElementById('save-entry');
const saveStatus = document.getElementById('save-status');
const entriesList = document.getElementById('entries-list');
const searchInput = document.getElementById('search-input');
const calendarInput = document.getElementById('calendar-input');
const fontFamilyInput = document.getElementById('font-family');
const fontSizeInput = document.getElementById('font-size');
const fontFamilyCustomInput = document.getElementById('font-family-custom');
const adminPhoneCodeInput = document.getElementById('admin-phone-code');
const adminPhoneNumberInput = document.getElementById('admin-phone-number');
const saveServerButton = document.getElementById('save-prefs-server');
const adminLoginButton = document.getElementById('admin-login');
const adminLogoutButton = document.getElementById('admin-logout');
const blogTitleInput = document.getElementById('blog-title-input');
const blogTitleDisplay = document.getElementById('blog-title-display');
const exportTimestamp = document.getElementById('export-timestamp');
const exportWordButton = document.getElementById('export-word');
const thesaurusInput = document.getElementById('thesaurus-input');
const thesaurusSearchButton = document.getElementById('thesaurus-search');
const thesaurusResults = document.getElementById('thesaurus-results');
const adminStatusBadge = document.getElementById('admin-dictionary-status');
const oxfordInput = document.getElementById('oxford-input');
const oxfordLookupButton = document.getElementById('oxford-lookup');
const oxfordResults = document.getElementById('oxford-results');
const connectSamsungPassRow = document.getElementById('connect-samsung-pass-row');
const connectSamsungPassButton = document.getElementById('connect-samsung-pass');
const smsProviderBanner = document.getElementById('sms-provider-banner');
const supportQrImage = document.getElementById('support-qr-image');
const supportQrLink = document.getElementById('support-qr-link');
const adminLoginQrImage = document.getElementById('admin-login-qr-image');
const adminLoginQrLink = document.getElementById('admin-login-qr-link');
const adminConfigPanel = document.getElementById('admin-config-panel');
const supportUrlInput = document.getElementById('support-url');
const supportLinkButton = document.getElementById('support-link-button');
const newSiteUrlInput = document.getElementById('new-site-url');
const newSiteBanner = document.getElementById('new-site-banner');
const newSiteLink = document.getElementById('new-site-link');
const newSiteRemindButton = document.getElementById('new-site-remind');

let pendingMfaToken = null;

function toBase64Url(bytes) {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '==='.slice((base64.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function encodeCredentialForJson(credential) {
  return {
    id: credential.id,
    rawId: toBase64Url(new Uint8Array(credential.rawId)),
    type: credential.type,
    response: {
      clientDataJSON: toBase64Url(new Uint8Array(credential.response.clientDataJSON)),
      attestationObject: credential.response.attestationObject
        ? toBase64Url(new Uint8Array(credential.response.attestationObject))
        : undefined,
      authenticatorData: credential.response.authenticatorData
        ? toBase64Url(new Uint8Array(credential.response.authenticatorData))
        : undefined,
      signature: credential.response.signature
        ? toBase64Url(new Uint8Array(credential.response.signature))
        : undefined,
      userHandle: credential.response.userHandle
        ? toBase64Url(new Uint8Array(credential.response.userHandle))
        : undefined,
      transports: credential.response.getTransports ? credential.response.getTransports() : undefined
    }
  };
}

function normalizeRegistrationOptions(options) {
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    user: {
      ...options.user,
      id: fromBase64Url(options.user.id)
    },
    excludeCredentials: (options.excludeCredentials || []).map((cred) => ({
      ...cred,
      id: fromBase64Url(cred.id)
    }))
  };
}

function normalizeAuthenticationOptions(options) {
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((cred) => ({
      ...cred,
      id: fromBase64Url(cred.id)
    }))
  };
}

function getFormattedTimestamp(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `(${month}/${day}/${year} ${hours}:${minutes} ${ampm})`;
}

function refreshTimestamp() {
  const formatted = getFormattedTimestamp(new Date());
  currentTimestamp.textContent = formatted;
  if (exportTimestamp) exportTimestamp.textContent = formatted;
}

function buildWordDocument(title, timestamp, content) {
  const escapedTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapedContent = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapedTitle}</title></head><body><h1>${escapedTitle}</h1><p><em>${timestamp}</em></p><div>${escapedContent}</div></body></html>`;
}

function buildAllEntriesDocument(entries) {
  const rows = entries.map(e => {
    const ts = e.timestamp || '';
    const body = (e.content || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');
    return `<div style="border-bottom:1px solid #ccc;margin-bottom:24px;padding-bottom:16px;"><p style="color:#888;font-size:0.9em;"><em>${ts}</em></p><div>${body}</div></div>`;
  }).join('\n');
  const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>My Blog Entries</title><style>body{font-family:'Book Antiqua',Georgia,serif;max-width:720px;margin:40px auto;line-height:1.7;}</style></head><body><h1>My Blog Entries</h1><p><em>Exported ${date}</em></p><hr/><br/>${rows}</body></html>`;
}

function downloadDocFile(filename, content) {
  const blob = new Blob([content], { type: 'application/msword' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

function handleWordExport() {
  const content = entryContent.value.trim() || 'No content yet.';
  const timestamp = exportTimestamp ? exportTimestamp.textContent : getFormattedTimestamp(new Date());
  const fileNameSafe = `entry_${Date.now()}`;
  const documentContent = buildWordDocument('Journal Entry', timestamp, content);
  downloadDocFile(`${fileNameSafe}.doc`, documentContent);
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/\'/g, '&#39;')
    .replace(/\n/g, '<br/>');
}

function renderEntries(entries) {
  entriesList.innerHTML = '';

  if (!entries.length) {
    entriesList.innerHTML = '<p>No entries found yet.</p>';
    return;
  }

  entries.forEach((entry) => {
    const card = document.createElement('article');
    card.className = 'entry-card';
    const isPublished = entry.published === 1 || entry.published === true;
    card.innerHTML = `
      <div class="entry-header">
        <div class="entry-timestamp">${escapeHtml(entry.timestamp)}</div>
      </div>
      <div class="entry-content">${escapeHtml(entry.content)}</div>
      <div class="entry-actions">
        <button class="publish-button" data-id="${entry.id}">${isPublished ? 'Unpublish' : 'Publish'}</button>
        <button class="archive-button" data-id="${entry.id}">Move to Database</button>
        <button class="word-export-btn secondary-button" data-id="${entry.id}">⬇ Word</button>
        <button class="delete-button" data-id="${entry.id}">Delete</button>
      </div>
    `;
    const deleteButton = card.querySelector('.delete-button');
    const publishButton = card.querySelector('.publish-button');
    const archiveButton = card.querySelector('.archive-button');
    const wordBtn = card.querySelector('.word-export-btn');
    deleteButton.addEventListener('click', () => deleteEntry(entry.id));
    publishButton.addEventListener('click', () => togglePublish(entry.id, !isPublished));
    archiveButton.addEventListener('click', () => archiveEntry(entry.id));
    wordBtn.addEventListener('click', () => {
      const doc = buildWordDocument('Journal Entry', entry.timestamp || '', entry.content || '');
      const safe = (entry.timestamp || Date.now()).toString().replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      downloadDocFile(`entry_${safe}.doc`, doc);
    });
    entriesList.appendChild(card);
  });
}

async function loadEntries() {
  const search = searchInput.value.trim();
  const date = calendarInput.value;
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (date) params.set('date', date);
  const url = `/api/entries?${params.toString()}`;
  try {
    const response = await fetch(url, { credentials: 'same-origin' });
    const entries = await response.json();
    if (Array.isArray(entries) && entries.length > 0) {
      // Cache entries in localStorage for resilience
      if (!search && !date) {
        try { localStorage.setItem('entries_cache', JSON.stringify(entries)); } catch {}
      }
      renderEntries(entries);
    } else if (!search && !date) {
      // Server returned nothing — try local cache
      try {
        const cached = localStorage.getItem('entries_cache');
        if (cached) {
          const cachedEntries = JSON.parse(cached);
          if (cachedEntries.length > 0) {
            renderEntries(cachedEntries);
            if (saveStatus) saveStatus.textContent = '(Showing cached entries — server may be restarting)';
            return;
          }
        }
      } catch {}
      renderEntries([]);
    } else {
      renderEntries(entries);
    }
  } catch {
    // Network error — try cache
    try {
      const cached = localStorage.getItem('entries_cache');
      if (cached) renderEntries(JSON.parse(cached));
    } catch {}
  }
}

async function saveEntry() {
  const content = entryContent.value.trim();

  if (!content) {
    saveStatus.textContent = 'Please write something before saving.';
    return;
  }

  saveEntryButton.disabled = true;
  saveStatus.textContent = 'Saving...';

  try {
    const title = `Entry ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    const response = await fetch('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ title, content })
    });

    if (response.status === 401 || response.status === 403) {
      saveStatus.textContent = 'Session expired — please log in again.';
      saveEntryButton.disabled = false;
      setTimeout(() => { window.location.href = '/login'; }, 1500);
      return;
    }

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      saveStatus.textContent = errData.error || 'Could not save entry. Try again.';
      saveEntryButton.disabled = false;
      return;
    }

    entryContent.value = '';
    refreshTimestamp();
    saveStatus.textContent = 'Entry saved.';
    saveEntryButton.disabled = false;
    await loadEntries();
    // Scroll to the bottom so the new entry is visible
    const el = document.getElementById('entries-list');
    if (el && el.lastElementChild) el.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end' });
  } catch (err) {
    saveStatus.textContent = 'Network error — check your connection and try again.';
    saveEntryButton.disabled = false;
  }
}

function applyFontFamily(fontFamily) {
  const defaultFamily = '"Book Antiqua", "Palatino Linotype", "Georgia", serif';
  if (!fontFamily) {
    document.documentElement.style.setProperty('--blog-font-family', defaultFamily);
    return;
  }
  document.documentElement.style.setProperty('--blog-font-family', fontFamily);
}

function applyFontSize(size) {
  if (!size) return;
  const trimmed = String(size).trim();
  if (!trimmed) return;
  // allow numbers (px) or explicit units (e.g. 1rem, 18px)
  const value = /^\d+$/.test(trimmed) ? `${trimmed}px` : trimmed;
  document.documentElement.style.setProperty('--blog-font-size', value);
}

function applyBlogTitle(title) {
  const value = title && title.trim() ? title.trim() : 'Your Personal Blog';
  if (blogTitleDisplay) blogTitleDisplay.textContent = value;
  document.title = `${value} - Personal Blog`;
}

function applySupportLink(url) {
  if (!supportLinkButton) return;
  const trimmed = url && url.trim();
  if (!trimmed) {
    supportLinkButton.href = '/support';
    supportLinkButton.textContent = 'Support';
    supportLinkButton.removeAttribute('target');
    return;
  }
  supportLinkButton.href = trimmed;
  supportLinkButton.textContent = 'Support';
  supportLinkButton.setAttribute('target', '_blank');
}

function toAbsoluteUrl(value, fallbackPath) {
  const fallback = new URL(fallbackPath, window.location.origin).toString();
  const raw = value && String(value).trim();
  if (!raw) return fallback;
  try {
    return new URL(raw, window.location.origin).toString();
  } catch (e) {
    return fallback;
  }
}

function setQrImage(imageElement, targetUrl) {
  if (!imageElement) return;
  const encoded = encodeURIComponent(targetUrl);
  imageElement.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encoded}`;
}

function refreshQrCodes() {
  const supportUrl = toAbsoluteUrl(supportUrlInput ? supportUrlInput.value : '', '/support');
  const adminLoginUrl = toAbsoluteUrl('/admin', '/admin');
  if (supportQrLink) supportQrLink.href = supportUrl;
  if (adminLoginQrLink) adminLoginQrLink.href = adminLoginUrl;
  setQrImage(supportQrImage, supportUrl);
  setQrImage(adminLoginQrImage, adminLoginUrl);
}

function updateNewSiteBanner(url) {
  if (!newSiteBanner || !newSiteLink) return;
  const trimmed = url && url.trim();
  const dismissed = localStorage.getItem('newSiteDismissed') === trimmed;
  if (!trimmed || dismissed) {
    newSiteBanner.style.display = 'none';
    return;
  }
  newSiteLink.href = trimmed;
  newSiteBanner.style.display = 'flex';
}

function hideNewSiteBannerForLater() {
  if (!newSiteBanner || !newSiteUrlInput) return;
  const trimmed = newSiteUrlInput.value.trim();
  if (trimmed) {
    localStorage.setItem('newSiteDismissed', trimmed);
  }
  newSiteBanner.style.display = 'none';
}

function saveBlogTitle() {
  if (!blogTitleInput) return;
  try {
    const title = blogTitleInput.value.trim();
    localStorage.setItem('blogTitle', title);
    applyBlogTitle(title);
  } catch (e) {
    // ignore storage errors
  }
}

function loadBlogTitle() {
  if (!blogTitleInput) return;
  try {
    const savedTitle = localStorage.getItem('blogTitle');
    if (savedTitle) {
      blogTitleInput.value = savedTitle;
      applyBlogTitle(savedTitle);
    } else {
      applyBlogTitle('Your Personal Blog');
    }
  } catch (e) {
    applyBlogTitle('Your Personal Blog');
  }
}

function savePreferences() {
  try {
    const appliedFont = getComputedStyle(document.documentElement).getPropertyValue('--blog-font-family').trim();
    const appliedSize = getComputedStyle(document.documentElement).getPropertyValue('--blog-font-size').trim();
    localStorage.setItem('blogFontFamily', appliedFont);
    localStorage.setItem('blogFontSize', appliedSize);
  } catch (e) {
    // ignore storage errors
  }
}

function renderThesaurusResults(word, entry) {
  if (!thesaurusResults) return;
  if (!word) {
    thesaurusResults.textContent = 'Enter a word to find synonyms and definitions.';
    return;
  }
  if (!entry || !entry.synonyms || !entry.synonyms.length) {
    const mwUrl = `https://www.merriam-webster.com/thesaurus/${encodeURIComponent(word)}`;
    thesaurusResults.innerHTML = `No synonyms found for "${word}". <a href="${mwUrl}" target="_blank" rel="noopener">Look up on Merriam-Webster Thesaurus</a>`;
    return;
  }
  const sorted = Array.isArray(entry.synonyms) ? entry.synonyms.slice().sort((a, b) => a.localeCompare(b)) : entry.synonyms;
  const mwUrl = `https://www.merriam-webster.com/thesaurus/${encodeURIComponent(word)}`;
  thesaurusResults.innerHTML = `
    <div class="thesaurus-heading">
      <strong>"${word}"</strong>
      <div class="thesaurus-definition">${entry.definition || ''}</div>
      <a href="${mwUrl}" target="_blank" rel="noopener" style="font-size:0.85em;">More synonyms on Merriam-Webster</a>
    </div>
    <div class="thesaurus-synonym-list">
      <strong>Synonyms</strong>
      <ul>${sorted.map(s => `<li>${s}</li>`).join('')}</ul>
    </div>
  `;
}

function getSynonyms(word) {
  const dictionary = {
    access: {
      definition: 'The act or means of approaching or entering a place; the ability to make use of something.',
      synonyms: ['admittance', 'entrance', 'entry', 'ingress', 'approach', 'passage', 'gateway', 'opening', 'admission', 'attainment']
    },
    accessible: {
      definition: 'Easy to approach, enter, or use; obtainable by a wide range of people.',
      synonyms: ['approachable', 'reachable', 'available', 'obtainable', 'handy', 'convenient', 'open', 'attainable', 'nearby', 'usable']
    },
    write: {
      definition: 'To form letters, words, or symbols on a surface, often for communication or record-keeping.',
      synonyms: ['compose', 'pen', 'scribe', 'author', 'draft', 'inscribe', 'record', 'notate', 'transcribe', 'jot down']
    },
    writing: {
      definition: 'The activity or skill of producing text for a purpose, such as communication, journaling, or literature.',
      synonyms: ['composing', 'scribing', 'penning', 'authoring', 'drafting', 'inscribing', 'recording', 'noting', 'transcribing', 'documenting']
    },
    blog: {
      definition: 'A regularly updated online journal or informational website written in an informal or conversational style.',
      synonyms: ['journal', 'diary', 'log', 'notebook', 'chronicle', 'memoir', 'record', 'ledger', 'bulletin', 'web journal']
    },
    entry: {
      definition: 'A distinct item or record within a list, diary, log, or book.',
      synonyms: ['item', 'article', 'record', 'notation', 'listing', 'paragraph', 'excerpt', 'log entry', 'post', 'recording']
    },
    journal: {
      definition: 'A personal or professional record of events, thoughts, or observations kept regularly.',
      synonyms: ['diary', 'ledger', 'logbook', 'chronicle', 'memoir', 'record', 'annal', 'register', 'notebook', 'journal']
    },
    support: {
      definition: 'Something provided to help, encourage, or sustain someone or something.',
      synonyms: ['aid', 'assistance', 'help', 'backing', 'sustenance', 'reinforcement', 'succor', 'comfort', 'patronage', 'support']
    },
    historical: {
      definition: 'Relating to past events or the record of events; having a strong connection to history.',
      synonyms: ['archaic', 'ancient', 'bygone', 'antique', 'time-honored', 'storied', 'heritage', 'age-old', 'traditional', 'classical']
    },
    professional: {
      definition: 'Having the skill, training, or qualifications appropriate for a profession.',
      synonyms: ['expert', 'adept', 'skilled', 'trained', 'polished', 'refined', 'seasoned', 'businesslike', 'competent', 'proficient']
    },
    page: {
      definition: 'One side of a sheet of paper in a book, or a portion of content on a screen.',
      synonyms: ['leaf', 'folio', 'sheet', 'panel', 'section', 'leaflet', 'screen', 'pane', 'page', 'surface']
    },
    document: {
      definition: 'A written, printed, or electronic record that provides information or evidence.',
      synonyms: ['manuscript', 'record', 'file', 'paper', 'report', 'certificate', 'memorandum', 'register', 'brief', 'archive']
    },
    time: {
      definition: 'The measured or measurable period during which an action, process, or condition exists or continues.',
      synonyms: ['moment', 'period', 'interval', 'epoch', 'era', 'season', 'duration', 'span', 'instant', 'occasion']
    },
    story: {
      definition: 'A narrative, either true or fictitious, designed to interest, entertain, or inform.',
      synonyms: ['tale', 'narrative', 'account', 'chronicle', 'legend', 'anecdote', 'saga', 'history', 'recital', 'report']
    },
    idea: {
      definition: 'A thought, plan, or concept formed by mental effort.',
      synonyms: ['concept', 'notion', 'thought', 'insight', 'belief', 'scheme', 'plan', 'vision', 'impression', 'suggestion']
    }
  };

  const normalized = word.trim().toLowerCase();
  if (!normalized) return null;

  const exact = dictionary[normalized];
  if (exact) return exact;

  const stem = normalized
    .replace(/(?:ing|ed|ies)$/, (match) => {
      if (match === 'ies') return 'y';
      return '';
    })
    .replace(/(?:s|es|ly)$/, '');

  if (stem && dictionary[stem]) {
    return dictionary[stem];
  }

  const fuzzy = Object.entries(dictionary).find(([key]) => key.startsWith(stem) || stem.startsWith(key) || key.includes(stem));
  if (fuzzy) return fuzzy[1];

  return null;
}

let oxfordDictionaryCache = null;

async function loadOxfordDictionary() {
  if (oxfordDictionaryCache) return oxfordDictionaryCache;
  try {
    const resp = await fetch('/api/library/dictionary');
    if (!resp.ok) return null;
    const payload = await resp.json();
    oxfordDictionaryCache = payload.data || payload;
    return oxfordDictionaryCache;
  } catch (e) {
    return null;
  }
}

function findOxfordEntry(word) {
  const normalized = word && word.trim().toLowerCase();
  if (!normalized) return null;
  if (oxfordDictionaryCache && oxfordDictionaryCache[normalized]) {
    return oxfordDictionaryCache[normalized];
  }
  return getSynonyms(word);
}

async function handleThesaurusSearch() {
  if (!thesaurusInput) return;
  const term = thesaurusInput.value.trim();
  if (!term) return;
  if (thesaurusResults) thesaurusResults.textContent = 'Looking up...';
  let entry = getSynonyms(term);
  if (!entry || !entry.synonyms || !entry.synonyms.length) {
    // Fallback to Free Dictionary API
    try {
      const resp = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`);
      if (resp.ok) {
        const data = await resp.json();
        const meanings = data[0]?.meanings || [];
        const firstMeaning = meanings[0];
        if (firstMeaning) {
          const def = firstMeaning.definitions[0]?.definition || '';
          const syns = [
            ...(firstMeaning.synonyms || []),
            ...(firstMeaning.definitions[0]?.synonyms || [])
          ].filter((s, i, a) => s && a.indexOf(s) === i);
          entry = { definition: def, synonyms: syns };
        }
      }
    } catch (e) { /* ignore */ }
  }
  renderThesaurusResults(term, entry);
}

function renderOxfordResult(word, entry) {
  if (!oxfordResults) return;
  if (!word) {
    oxfordResults.textContent = 'Enter a word to look up.';
    return;
  }
  if (!entry || !entry.definition) {
    const mwUrl = `https://www.merriam-webster.com/dictionary/${encodeURIComponent(word)}`;
    oxfordResults.innerHTML = `No local definition found for "${word}". <a href="${mwUrl}" target="_blank" rel="noopener">Look up on Merriam-Webster</a>`;
    return;
  }
  const syns = entry.synonyms || [];
  const sorted = Array.isArray(syns) ? syns.slice().sort((a, b) => a.localeCompare(b)) : [];
  const mwUrl = `https://www.merriam-webster.com/dictionary/${encodeURIComponent(word)}`;
  oxfordResults.innerHTML = `
    <div class="thesaurus-heading">
      <strong>${word}</strong>
      <div class="thesaurus-definition">${entry.definition}</div>
      <a href="${mwUrl}" target="_blank" rel="noopener" style="font-size:0.85em;">Full definition on Merriam-Webster</a>
    </div>
    <div class="thesaurus-synonym-list">
      <strong>Related</strong>
      <ul>${sorted.map(s => `<li>${s}</li>`).join('')}</ul>
    </div>
  `;
}

async function handleOxfordLookup() {
  const term = (oxfordInput && oxfordInput.value.trim());
  if (!term) return;
  if (oxfordResults) oxfordResults.textContent = 'Looking up...';
  await loadOxfordDictionary();
  let entry = findOxfordEntry(term);
  if (!entry || !entry.definition) {
    // Fallback to Free Dictionary API
    try {
      const resp = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`);
      if (resp.ok) {
        const data = await resp.json();
        const meanings = data[0]?.meanings || [];
        const firstMeaning = meanings[0];
        if (firstMeaning) {
          const def = firstMeaning.definitions[0]?.definition || '';
          const syns = firstMeaning.definitions[0]?.synonyms || firstMeaning.synonyms || [];
          entry = { definition: def, synonyms: syns };
        }
      }
    } catch (e) { /* ignore */ }
  }
  renderOxfordResult(term, entry);
}

async function loadPreferences() {
  // Try server settings first
  try {
    const resp = await fetch('/api/settings');
    if (resp.ok) {
      const obj = await resp.json();
      if (obj.fontFamily) {
        document.documentElement.style.setProperty('--blog-font-family', obj.fontFamily);
        if (fontFamilyInput) {
          const opts = Array.from(fontFamilyInput.options).map(o => o.value);
          if (opts.includes(obj.fontFamily)) {
            fontFamilyInput.value = obj.fontFamily;
            if (fontFamilyCustomInput) fontFamilyCustomInput.style.display = 'none';
          } else {
            fontFamilyInput.value = 'custom';
            if (fontFamilyCustomInput) {
              fontFamilyCustomInput.style.display = 'block';
              fontFamilyCustomInput.value = obj.fontFamily.replace(/^"|"$/g, '');
            }
          }
        }
      }
      if (obj.fontSize) {
        document.documentElement.style.setProperty('--blog-font-size', obj.fontSize);
        if (fontSizeInput) {
          const m = obj.fontSize.match(/^(\d+)px$/);
          fontSizeInput.value = m ? m[1] : obj.fontSize;
        }
      }
          if (obj.supportUrl && supportUrlInput) {
        supportUrlInput.value = obj.supportUrl;
      }
      if (obj.newSiteUrl && newSiteUrlInput) {
        newSiteUrlInput.value = obj.newSiteUrl;
      }
      if (newSiteUrlInput) {
        updateNewSiteBanner(newSiteUrlInput.value.trim());
      }
      return;
    }
  } catch (e) {
    // ignore and fallback to localStorage
  }

  // Fallback to localStorage
  try {
    const savedFont = localStorage.getItem('blogFontFamily');
    const savedSize = localStorage.getItem('blogFontSize');
    if (savedFont) {
      // apply to CSS
      document.documentElement.style.setProperty('--blog-font-family', savedFont);
      // update UI: try to match a select option
      if (fontFamilyInput) {
        const opts = Array.from(fontFamilyInput.options).map(o => o.value);
        if (opts.includes(savedFont)) {
          fontFamilyInput.value = savedFont;
          if (fontFamilyCustomInput) fontFamilyCustomInput.style.display = 'none';
        } else {
          // custom
          fontFamilyInput.value = 'custom';
          if (fontFamilyCustomInput) {
            fontFamilyCustomInput.style.display = 'block';
            fontFamilyCustomInput.value = savedFont.replace(/^"|"$/g, '');
          }
        }
      }
    }
    if (savedSize) {
      document.documentElement.style.setProperty('--blog-font-size', savedSize);
      if (fontSizeInput) {
        // if savedSize ends with px, strip for numeric input
        const m = savedSize.match(/^(\d+)px$/);
        fontSizeInput.value = m ? m[1] : savedSize;
      }
    }
  } catch (e) {
    // ignore
  }
}

async function archiveEntry(entryId) {
  const response = await fetch(`/api/entries/${entryId}/archive`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin'
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    saveStatus.textContent = error?.error || 'Could not move entry. Make sure you are logged in.';
    return;
  }
  saveStatus.textContent = 'Entry moved to Database.';
  loadEntries();
}

async function deleteEntry(entryId) {
  const confirmation = prompt('Type "delete permanently" to confirm deletion:');
  if (!confirmation || confirmation.trim().toLowerCase() !== 'delete permanently') {
    saveStatus.textContent = 'Deletion cancelled.';
    return;
  }
  const response = await fetch(`/api/entries/${entryId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const error = await response.json();
    saveStatus.textContent = error?.error || 'Failed to delete entry.';
    return;
  }

  saveStatus.textContent = 'Entry deleted successfully.';
  loadEntries();
}

async function togglePublish(entryId, publish) {
  const response = await fetch(`/api/entries/${entryId}/publish`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ publish })
  });

  if (!response.ok) {
    if (response.status === 403) {
      saveStatus.textContent = 'You must be logged in as admin to publish. Use the Admin Login section below.';
      return;
    }
    const error = await response.json().catch(() => ({}));
    saveStatus.textContent = error?.error || 'Failed to update publish status.';
    return;
  }

  if (publish) {
    window.location.href = '/published';
  } else {
    saveStatus.textContent = 'Entry unpublished.';
    loadEntries();
  }
}

saveEntryButton.addEventListener('click', saveEntry);
searchInput.addEventListener('input', loadEntries);
calendarInput.addEventListener('change', loadEntries);
if (fontFamilyInput) {
  fontFamilyInput.addEventListener('change', () => {
    const v = fontFamilyInput.value;
    if (v === 'custom') {
      if (fontFamilyCustomInput) fontFamilyCustomInput.style.display = 'block';
      if (fontFamilyCustomInput) applyFontFamily(fontFamilyCustomInput.value.trim());
    } else {
      if (fontFamilyCustomInput) fontFamilyCustomInput.style.display = 'none';
      applyFontFamily(v);
    }
  });
}
if (fontFamilyCustomInput) {
  fontFamilyCustomInput.addEventListener('input', () => applyFontFamily(fontFamilyCustomInput.value.trim()));
}
if (fontSizeInput) fontSizeInput.addEventListener('input', () => applyFontSize(fontSizeInput.value.trim()));
if (newSiteUrlInput) newSiteUrlInput.addEventListener('input', () => updateNewSiteBanner(newSiteUrlInput.value.trim()));
if (newSiteRemindButton) newSiteRemindButton.addEventListener('click', (e) => {
  e.preventDefault();
  hideNewSiteBannerForLater();
});
if (exportWordButton) exportWordButton.addEventListener('click', handleWordExport);

const exportAllWordButton = document.getElementById('export-all-word');
if (exportAllWordButton) {
  exportAllWordButton.addEventListener('click', async () => {
    try {
      const r = await fetch('/api/entries', { credentials: 'same-origin' });
      if (!r.ok) { alert('Could not load entries. Make sure you are logged in.'); return; }
      const entries = await r.json();
      if (!entries.length) { alert('No saved entries to export yet.'); return; }
      const doc = buildAllEntriesDocument(entries);
      const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).replace(/[, ]+/g, '_');
      downloadDocFile(`my_journal_entries_${dateStr}.doc`, doc);
    } catch { alert('Network error. Try again.'); }
  });
}

refreshTimestamp();
loadBlogTitle();
// load preferences (server first, then local) and then entries
loadPreferences().then(() => {
  if (supportUrlInput) applySupportLink(supportUrlInput.value.trim());
  if (newSiteUrlInput) updateNewSiteBanner(newSiteUrlInput.value.trim());
  refreshQrCodes();
  loadEntries();
});
// save preferences whenever user changes inputs
if (blogTitleInput) blogTitleInput.addEventListener('input', saveBlogTitle);
if (fontFamilyInput) fontFamilyInput.addEventListener('change', savePreferences);
if (fontFamilyCustomInput) fontFamilyCustomInput.addEventListener('input', savePreferences);
if (fontSizeInput) fontSizeInput.addEventListener('input', () => { applyFontSize(fontSizeInput.value.trim()); savePreferences(); });
if (supportUrlInput) {
  supportUrlInput.addEventListener('input', () => {
    applySupportLink(supportUrlInput.value.trim());
    refreshQrCodes();
  });
}
// initial load of entries after preferences applied

// Save preferences to server (admin-protected)
async function savePreferencesToServer() {
  const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--blog-font-family').trim();
  const fontSize = getComputedStyle(document.documentElement).getPropertyValue('--blog-font-size').trim();
  const supportUrl = supportUrlInput ? supportUrlInput.value.trim() : '';
  const newSiteUrl = newSiteUrlInput ? newSiteUrlInput.value.trim() : '';
  saveStatus.textContent = 'Saving preferences to server...';
  try {
    const resp = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fontFamily, fontSize, supportUrl, newSiteUrl })
    });
    if (resp.status === 401) {
      saveStatus.textContent = 'Not authenticated. Use Samsung Pass fingerprint + text code login first.';
      return;
    }
    if (!resp.ok) {
      const err = await resp.json();
      saveStatus.textContent = err?.error || 'Failed to save preferences to server.';
      return;
    }
    saveStatus.textContent = 'Preferences saved to server.';
    savePreferences();
    if (supportUrl) applySupportLink(supportUrl);
    if (newSiteUrlInput && newSiteUrl) updateNewSiteBanner(newSiteUrl);
    await checkAdminSession();
  } catch (e) {
    saveStatus.textContent = 'Failed to save preferences to server.';
  }
}

async function sendSmsCode() {
  if (!pendingMfaToken) {
    saveStatus.textContent = 'Start fingerprint login first.';
    return false;
  }
  const phoneNumber = adminPhoneNumberInput?.value.trim() || '';
  try {
    const resp = await fetch('/api/admin/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaToken: pendingMfaToken, phoneNumber })
    });
    const body = await resp.json();
    if (!resp.ok) {
      saveStatus.textContent = body.error || 'Could not send text code.';
      return false;
    }
    const destination = body.destination || phoneNumber;
    if (body.fallback && body.fallbackCode) {
      saveStatus.textContent = `SMS fallback active. Use code ${body.fallbackCode} to finish login.`;
      return true;
    }
    saveStatus.textContent = `Text code sent to ${destination}. Enter the code to finish login.`;
    return true;
  } catch (e) {
    saveStatus.textContent = 'Could not send text code.';
    return false;
  }
}

async function completePendingPhoneVerification() {
  if (!pendingMfaToken) return;
  const code = adminPhoneCodeInput?.value.trim();
  if (!code) {
    saveStatus.textContent = 'Enter your phone verification code.';
    return;
  }
  try {
    const phoneResp = await fetch('/api/admin/sms/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaToken: pendingMfaToken, code })
    });
    const phoneBody = await phoneResp.json();
    if (!phoneResp.ok) {
      saveStatus.textContent = phoneBody.error || 'Phone verification failed.';
      return;
    }
    pendingMfaToken = null;
    saveStatus.textContent = 'Admin logged in with Samsung Pass fingerprint and text code.';
    await checkAdminSession();
  } catch (e) {
    saveStatus.textContent = 'Phone verification failed.';
  }
}

async function adminLogin() {
  if (!window.PublicKeyCredential) {
    saveStatus.textContent = 'Use Samsung Internet or Chrome with Samsung Wallet/Samsung Pass enabled.';
    return;
  }
  if (pendingMfaToken) {
    await completePendingPhoneVerification();
    return;
  }

  try {
    const optionsResp = await fetch('/api/admin/passkey/login/options', { method: 'POST' });
    const optionsBody = await optionsResp.json();
    if (!optionsResp.ok) {
      if (String(optionsBody?.error || '').includes('No fingerprint registered yet')) {
        saveStatus.textContent = 'No fingerprint registered yet. Starting Samsung Pass enrollment...';
        const enrolled = await connectSamsungPass();
        if (enrolled) {
          saveStatus.textContent = 'Samsung Pass enrolled. Tap Login again to verify fingerprint and receive your text code.';
        }
        return;
      }
      saveStatus.textContent = optionsBody.error || 'Unable to start fingerprint login.';
      return;
    }

    const options = normalizeAuthenticationOptions(optionsBody);
    const assertion = await navigator.credentials.get({ publicKey: options });
    if (!assertion) {
      saveStatus.textContent = 'Fingerprint login was canceled.';
      return;
    }

    const verifyResp = await fetch('/api/admin/passkey/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: encodeCredentialForJson(assertion) })
    });
    const verifyBody = await verifyResp.json();
    if (!verifyResp.ok) {
      saveStatus.textContent = verifyBody.error || 'Fingerprint login failed.';
      return;
    }

    if (!verifyBody.mfaRequired) {
      saveStatus.textContent = 'Fingerprint accepted, but SMS step is unavailable.';
      return;
    }

    pendingMfaToken = verifyBody.mfaToken;
    const sent = await sendSmsCode();
    if (!sent) return;

    const code = adminPhoneCodeInput?.value.trim();
    if (!code) {
      saveStatus.textContent = 'Fingerprint accepted. Enter the 6-digit text code and tap Login again.';
      return;
    }
    await completePendingPhoneVerification();
  } catch (e) {
    if (e && e.name === 'NotAllowedError') {
      saveStatus.textContent = 'Fingerprint prompt was canceled or blocked. Unlock phone and retry in Samsung Internet or Chrome.';
      return;
    }
    saveStatus.textContent = 'Login failed.';
  }
}

async function adminLogout() {
  try {
    const resp = await fetch('/api/admin/logout', { method: 'POST' });
    if (!resp.ok) {
      saveStatus.textContent = 'Logout failed.';
      return;
    }
    saveStatus.textContent = 'Logged out.';
    if (adminLoginButton) adminLoginButton.style.display = 'inline-block';
    if (adminLogoutButton) adminLogoutButton.style.display = 'none';
    await refreshAdminDictionaryStatus(false);
  } catch (e) {
    saveStatus.textContent = 'Logout failed.';
  }
}

async function connectSamsungPass() {
  if (!window.PublicKeyCredential) {
    saveStatus.textContent = 'This device/browser cannot connect Samsung Pass. Use Samsung Internet or Chrome.';
    return false;
  }

  if (window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
    try {
      const available = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      if (!available) {
        saveStatus.textContent = 'No platform fingerprint authenticator detected. Enable Samsung Pass in Samsung Wallet.';
        return false;
      }
    } catch (e) {
      // Continue even if availability probe fails.
    }
  }

  try {
    const optionsResp = await fetch('/api/admin/passkey/register/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const optionsBody = await optionsResp.json();
    if (!optionsResp.ok) {
      saveStatus.textContent = optionsBody.error || 'Could not start Samsung Pass connection.';
      return false;
    }

    const options = normalizeRegistrationOptions(optionsBody);
    const credential = await navigator.credentials.create({ publicKey: options });
    if (!credential) {
      saveStatus.textContent = 'Samsung Pass connection was canceled.';
      return false;
    }

    const verifyResp = await fetch('/api/admin/passkey/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: encodeCredentialForJson(credential) })
    });
    const verifyBody = await verifyResp.json();
    if (!verifyResp.ok) {
      saveStatus.textContent = verifyBody.error || 'Samsung Pass connection failed.';
      return false;
    }

    saveStatus.textContent = 'Samsung Pass connected on this phone.';
    return true;
  } catch (e) {
    if (e && e.name === 'NotAllowedError') {
      saveStatus.textContent = 'Fingerprint prompt was canceled or blocked. Unlock phone and try again.';
      return false;
    }
    saveStatus.textContent = 'Samsung Pass connection failed.';
    return false;
  }
}

async function loadSmsProviderStatus() {
  if (!smsProviderBanner) return;
  try {
    const resp = await fetch('/api/admin/sms/status');
    if (!resp.ok) {
      smsProviderBanner.style.display = 'none';
      return;
    }
    const status = await resp.json();
    smsProviderBanner.style.display = 'block';
    smsProviderBanner.classList.remove('status-ok', 'status-fallback', 'status-error');
    if (status.configured) {
      smsProviderBanner.classList.add('status-ok');
      smsProviderBanner.textContent = 'SMS provider configured: real text messages are enabled.';
      return;
    }
    if (status.devFallback) {
      smsProviderBanner.classList.add('status-fallback');
      smsProviderBanner.textContent = `SMS provider not configured (${(status.missing || []).join(', ')}). Development fallback codes are active.`;
      return;
    }
    smsProviderBanner.classList.add('status-error');
    smsProviderBanner.textContent = `SMS provider not configured (${(status.missing || []).join(', ')}).`;
  } catch (e) {
    smsProviderBanner.style.display = 'none';
  }
}

if (saveServerButton) saveServerButton.addEventListener('click', savePreferencesToServer);
if (adminLoginButton) adminLoginButton.addEventListener('click', adminLogin);
if (adminLogoutButton) adminLogoutButton.addEventListener('click', adminLogout);
if (connectSamsungPassButton) connectSamsungPassButton.addEventListener('click', connectSamsungPass);
if (adminPhoneCodeInput) {
  adminPhoneCodeInput.addEventListener('keypress', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      adminLogin();
    }
  });
}
if (thesaurusSearchButton) thesaurusSearchButton.addEventListener('click', handleThesaurusSearch);
if (thesaurusInput) thesaurusInput.addEventListener('keypress', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleThesaurusSearch();
  }
});
if (oxfordLookupButton) oxfordLookupButton.addEventListener('click', handleOxfordLookup);
if (oxfordInput) oxfordInput.addEventListener('keypress', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleOxfordLookup();
  }
});

// Spellcheck
const spellcheckInput = document.getElementById('spellcheck-input');
const spellcheckBtn = document.getElementById('spellcheck-btn');
const spellcheckResults = document.getElementById('spellcheck-results');

async function handleSpellcheck() {
  if (!spellcheckInput || !spellcheckResults) return;
  const word = spellcheckInput.value.trim();
  if (!word) { spellcheckResults.textContent = 'Enter a word to check.'; return; }
  spellcheckResults.textContent = 'Checking...';
  try {
    const resp = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (resp.ok) {
      spellcheckResults.innerHTML = `✅ <strong>${word}</strong> is spelled correctly.`;
    } else if (resp.status === 404) {
      const mwUrl = `https://www.merriam-webster.com/dictionary/${encodeURIComponent(word)}`;
      spellcheckResults.innerHTML = `❌ <strong>${word}</strong> — not recognized. <a href="${mwUrl}" target="_blank" rel="noopener">Check on Merriam-Webster</a>`;
    } else {
      spellcheckResults.textContent = 'Could not check spelling right now.';
    }
  } catch (e) {
    spellcheckResults.textContent = 'Could not check spelling right now.';
  }
}

if (spellcheckBtn) spellcheckBtn.addEventListener('click', handleSpellcheck);
if (spellcheckInput) spellcheckInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); handleSpellcheck(); }
});

async function refreshAdminDictionaryStatus(isAdmin) {
  if (!adminStatusBadge) return;
  if (!isAdmin) {
    adminStatusBadge.style.display = 'none';
    return;
  }

  const dict = await loadOxfordDictionary();
  adminStatusBadge.style.display = 'block';

  if (dict) {
    adminStatusBadge.textContent = 'Admin only: dictionary loaded';
    adminStatusBadge.classList.add('status-loaded');
    adminStatusBadge.classList.remove('status-missing');
  } else {
    adminStatusBadge.textContent = 'Admin only: dictionary missing';
    adminStatusBadge.classList.add('status-missing');
    adminStatusBadge.classList.remove('status-loaded');
  }
}

async function checkAdminSession() {
  const adminQrRow = document.getElementById('admin-qr-row');
  try {
    const resp = await fetch('/api/admin/session');
    if (!resp.ok) {
      if (adminLoginButton) adminLoginButton.style.display = 'inline-block';
      if (adminLogoutButton) adminLogoutButton.style.display = 'none';
      if (connectSamsungPassRow) connectSamsungPassRow.style.display = 'none';
      if (adminConfigPanel) adminConfigPanel.style.display = 'none';
      if (adminQrRow) adminQrRow.style.display = 'none';
      await refreshAdminDictionaryStatus(false);
      return;
    }
    const obj = await resp.json();
    if (obj.authenticated) {
      if (adminLoginButton) adminLoginButton.style.display = 'none';
      if (adminLogoutButton) adminLogoutButton.style.display = 'inline-block';
      if (connectSamsungPassRow) connectSamsungPassRow.style.display = 'flex';
      if (adminConfigPanel) adminConfigPanel.style.display = 'block';
      if (adminQrRow) adminQrRow.style.display = 'flex';
      await refreshAdminDictionaryStatus(true);
    } else {
      if (adminLoginButton) adminLoginButton.style.display = 'inline-block';
      if (adminLogoutButton) adminLogoutButton.style.display = 'none';
      if (connectSamsungPassRow) connectSamsungPassRow.style.display = 'none';
      if (adminConfigPanel) adminConfigPanel.style.display = 'none';
      if (adminQrRow) adminQrRow.style.display = 'none';
      await refreshAdminDictionaryStatus(false);
    }
  } catch (e) {
    if (adminLoginButton) adminLoginButton.style.display = 'inline-block';
    if (adminLogoutButton) adminLogoutButton.style.display = 'none';
    if (connectSamsungPassRow) connectSamsungPassRow.style.display = 'none';
    if (adminConfigPanel) adminConfigPanel.style.display = 'none';
    if (adminQrRow) adminQrRow.style.display = 'none';
    await refreshAdminDictionaryStatus(false);
  }
}

// check session on load and update UI
checkAdminSession();
loadSmsProviderStatus();
refreshQrCodes();

// ── User account session ──────────────────────────────────────────────────────
const userAccountBar = document.getElementById('user-account-bar');
const userGreeting = document.getElementById('user-greeting');
const userLogoutBtn = document.getElementById('user-logout-btn');
const userLoginPrompt = document.getElementById('user-login-prompt');

async function checkUserSession() {
  try {
    const r = await fetch('/api/auth/session', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('no session endpoint');
    const data = await r.json();
    if (data.authenticated) {
      localStorage.setItem('blog_username', data.username);
      localStorage.setItem('blog_logged_in', '1');
      if (userAccountBar) { userAccountBar.style.display = 'flex'; }
      if (userGreeting) userGreeting.textContent = `Logged in as ${data.username}`;
      if (userLoginPrompt) userLoginPrompt.style.display = 'none';
    } else {
      // Server session gone — clear stale localStorage and show login prompt
      localStorage.removeItem('blog_username');
      localStorage.removeItem('blog_logged_in');
      localStorage.removeItem('entries_cache');
      if (userAccountBar) userAccountBar.style.display = 'none';
      if (userLoginPrompt) userLoginPrompt.style.display = 'block';
    }
  } catch {
    // Network error — still show from localStorage
    const lsUser = localStorage.getItem('blog_username');
    if (lsUser && localStorage.getItem('blog_logged_in')) {
      if (userAccountBar) { userAccountBar.style.display = 'flex'; }
      if (userGreeting) userGreeting.textContent = `Logged in as ${lsUser}`;
      if (userLoginPrompt) userLoginPrompt.style.display = 'none';
    }
  }
}

if (userLogoutBtn) {
  userLogoutBtn.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    localStorage.removeItem('blog_username');
    localStorage.removeItem('blog_logged_in');
    localStorage.removeItem('entries_cache');
    window.location.reload();
  });
}

checkUserSession();

// Redirect to correct signup tab if flagged
if (localStorage.getItem('auth_tab') === 'signup') {
  localStorage.removeItem('auth_tab');
}
