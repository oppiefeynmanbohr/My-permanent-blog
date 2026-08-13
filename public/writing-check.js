(function () {
  const entryField = document.getElementById('entry-content');
  if (!entryField) return;

  const controls = document.createElement('div');
  controls.className = 'writing-check-controls';
  controls.innerHTML = '<button type="button" class="secondary-button" id="check-writing">Check writing</button><span id="writing-check-status" class="save-status" aria-live="polite"></span><div id="writing-check-results" class="writing-check-results"></div>';
  entryField.parentElement.appendChild(controls);

  const checkButton = controls.querySelector('#check-writing');
  const status = controls.querySelector('#writing-check-status');
  const results = controls.querySelector('#writing-check-results');

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
  }

  function applyFixes(matches) {
    let corrected = entryField.value;
    [...matches].sort((a, b) => b.offset - a.offset).forEach((match) => {
      const replacement = match.replacements?.[0]?.value;
      if (replacement === undefined) return;
      corrected = corrected.slice(0, match.offset) + replacement + corrected.slice(match.offset + match.length);
    });
    entryField.value = corrected;
    entryField.dispatchEvent(new Event('input', { bubbles: true }));
    results.textContent = 'Suggested fixes applied. Review the entry before saving.';
  }

  checkButton.addEventListener('click', async () => {
    const text = entryField.value.trim();
    if (!text) {
      status.textContent = 'Write something before checking it.';
      return;
    }
    checkButton.disabled = true;
    status.textContent = 'Checking spelling and grammar...';
    results.innerHTML = '';
    try {
      const response = await fetch('/api/grammar-check', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Grammar service unavailable.');
      const matches = Array.isArray(data.matches) ? data.matches : [];
      if (!matches.length) {
        status.textContent = 'No spelling or grammar issues found.';
        return;
      }
      status.textContent = `${matches.length} possible issue${matches.length === 1 ? '' : 's'} found.`;
      results.innerHTML = `<ul>${matches.slice(0, 20).map((match) => `<li><strong>${escapeHtml(match.message)}</strong>${match.replacements?.[0]?.value ? ` Suggested: <em>${escapeHtml(match.replacements[0].value)}</em>` : ''}</li>`).join('')}</ul><button type="button" class="secondary-button" id="apply-writing-fixes">Apply fixes</button>`;
      results.querySelector('#apply-writing-fixes').addEventListener('click', () => applyFixes(matches));
    } catch (error) {
      status.textContent = error.message || 'Could not check the entry.';
    } finally {
      checkButton.disabled = false;
    }
  });
})();