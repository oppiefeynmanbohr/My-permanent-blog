async function fetchThesaurus() {
  try {
    const resp = await fetch('/api/library/thesaurus');
    if (!resp.ok) throw new Error('No thesaurus available');
    const obj = await resp.json();
    return obj.data || obj;
  } catch (e) {
    return null;
  }
}

function normalizeWord(w) {
  return w && w.trim().toLowerCase();
}

async function fetchDictionary() {
  try {
    const resp = await fetch('/api/library/dictionary');
    if (!resp.ok) return null;
    const obj = await resp.json();
    return obj.data || obj;
  } catch (e) {
    return null;
  }
}

function renderEntry(word, entry, container) {
  if (!entry) return;
  const def = entry.definition || '';
  const syns = entry.synonyms || (Array.isArray(entry) ? entry : []);
  const sortedSyns = Array.isArray(syns) ? syns.slice().sort((a, b) => a.localeCompare(b)) : [];
  container.innerHTML = `
    <div class="thesaurus-heading"><strong>${word}</strong>
      <div class="thesaurus-definition">${def}</div>
    </div>
    <div class="thesaurus-synonym-list">
      <strong>Synonyms</strong>
      <ul>${sortedSyns.map(s => `<li>${s}</li>`).join('')}</ul>
    </div>
  `;
}

function simpleMatch(term, dictionary) {
  const t = normalizeWord(term);
  if (!t) return null;
  // exact
  if (dictionary[t]) return { word: t, entry: dictionary[t] };
  // stem match
  const stem = t.replace(/(?:ing|ed|ies)$/, (m) => (m === 'ies' ? 'y' : '')).replace(/(?:s|es|ly)$/, '');
  if (dictionary[stem]) return { word: stem, entry: dictionary[stem] };
  // fuzzy: search keys containing term
  const keys = Object.keys(dictionary);
  const foundKey = keys.find(k => k.includes(stem) || stem.includes(k));
  if (foundKey) return { word: foundKey, entry: dictionary[foundKey] };
  // synonyms contains term
  for (const k of keys) {
    const val = dictionary[k];
    const syns = Array.isArray(val) ? val : val.synonyms || [];
    if (syns.map(s => s.toLowerCase()).includes(t)) return { word: k, entry: val };
  }
  return null;
}

document.addEventListener('DOMContentLoaded', async () => {
  const searchInput = document.getElementById('lib-search');
  const searchBtn = document.getElementById('lib-search-btn');
  const results = document.getElementById('lib-results');
  const uploadBtn = document.getElementById('lib-upload-btn');
  const uploadContent = document.getElementById('lib-upload-content');
  const uploadStatus = document.getElementById('lib-upload-status');
  const dictUploadBtn = document.getElementById('lib-dict-upload-btn');
  const dictUploadContent = document.getElementById('lib-dict-upload-content');
  const dictUploadStatus = document.getElementById('lib-dict-upload-status');
  const adminPw = document.getElementById('admin-password-upload');
  const adminUploadSection = document.getElementById('admin-upload-section');
  const adminUploadLocked = document.getElementById('admin-upload-locked');

  let dictionary = await fetchThesaurus();
  let oxfordDictionary = await fetchDictionary();
  if (!dictionary) {
    results.textContent = 'No thesaurus found. Place a JSON file at data/thesaurus.json or upload via the admin form below.';
  }

  async function refreshAdminUploadVisibility() {
    if (!adminUploadSection || !adminUploadLocked) return;

    try {
      const resp = await fetch('/api/admin/session');
      if (!resp.ok) {
        adminUploadSection.style.display = 'none';
        adminUploadLocked.style.display = 'block';
        return;
      }
      const obj = await resp.json();
      if (obj.authenticated) {
        adminUploadSection.style.display = 'block';
        adminUploadLocked.style.display = 'none';
      } else {
        adminUploadSection.style.display = 'none';
        adminUploadLocked.style.display = 'block';
      }
    } catch (e) {
      adminUploadSection.style.display = 'none';
      adminUploadLocked.style.display = 'block';
    }
  }

  await refreshAdminUploadVisibility();

  async function doSearch() {
    const term = searchInput.value.trim();
    if (!term) return;
    if (!dictionary) {
      results.textContent = 'No thesaurus loaded.';
      return;
    }
    const match = simpleMatch(term, dictionary);
    if (!match) {
      results.textContent = `No matches for "${term}".`;
      return;
    }
    renderEntry(match.word, match.entry, results);
  }

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') doSearch(); });

  uploadBtn.addEventListener('click', async () => {
    uploadStatus.textContent = '';
    let parsed = null;
    try {
      parsed = JSON.parse(uploadContent.value);
    } catch (e) {
      uploadStatus.textContent = 'Invalid JSON.';
      return;
    }
    try {
      const resp = await fetch('/api/library/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thesaurus: parsed, password: adminPw.value })
      });
      const body = await resp.json();
      if (!resp.ok) {
        uploadStatus.textContent = body.error || 'Upload failed';
        return;
      }
      uploadStatus.textContent = 'Thesaurus uploaded and loaded.';
      dictionary = parsed;
      results.textContent = 'Thesaurus uploaded and loaded.';
    } catch (e) {
      uploadStatus.textContent = 'Upload failed.';
    }
  });

  dictUploadBtn.addEventListener('click', async () => {
    dictUploadStatus.textContent = '';
    let parsed = null;
    try {
      parsed = JSON.parse(dictUploadContent.value);
    } catch (e) {
      dictUploadStatus.textContent = 'Invalid JSON.';
      return;
    }
    try {
      const resp = await fetch('/api/library/dictionary-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dictionary: parsed, password: adminPw.value })
      });
      const body = await resp.json();
      if (!resp.ok) {
        dictUploadStatus.textContent = body.error || 'Upload failed';
        return;
      }
      dictUploadStatus.textContent = 'Dictionary uploaded successfully.';
      oxfordDictionary = parsed;
    } catch (e) {
      dictUploadStatus.textContent = 'Upload failed.';
    }
  });
});
