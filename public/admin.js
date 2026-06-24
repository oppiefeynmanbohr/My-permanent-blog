const adminPhoneCodeInput = document.getElementById('admin-phone-code');
const adminPhoneNumberInput = document.getElementById('admin-phone-number');
const saveServerButton = document.getElementById('save-prefs-server');
const adminLoginButton = document.getElementById('admin-login');
const adminLogoutButton = document.getElementById('admin-logout');
const connectSamsungPassRow = document.getElementById('connect-samsung-pass-row');
const connectSamsungPassButton = document.getElementById('connect-samsung-pass');
const smsProviderBanner = document.getElementById('sms-provider-banner');
const adminStatusBadge = document.getElementById('admin-dictionary-status');
const adminConfigPanel = document.getElementById('admin-config-panel');
const adminStatusBanner = document.getElementById('admin-status');
const fontFamilyInput = document.getElementById('font-family');
const fontSizeInput = document.getElementById('font-size');
const fontFamilyCustomInput = document.getElementById('font-family-custom');
const supportUrlInput = document.getElementById('support-url');
const venmoUrlInput = document.getElementById('venmo-url');
const newSiteUrlInput = document.getElementById('new-site-url');

let pendingMfaToken = null;

function setStatus(message) {
  if (adminStatusBanner) {
    adminStatusBanner.textContent = message;
  }
}

function formatAuthError(error, fallbackMessage) {
  if (!error) return fallbackMessage;
  const name = error.name ? `${error.name}: ` : '';
  const detail = error.message ? error.message : fallbackMessage;
  return `${name}${detail}`;
}

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
      attestationObject: credential.response.attestationObject ? toBase64Url(new Uint8Array(credential.response.attestationObject)) : undefined,
      authenticatorData: credential.response.authenticatorData ? toBase64Url(new Uint8Array(credential.response.authenticatorData)) : undefined,
      signature: credential.response.signature ? toBase64Url(new Uint8Array(credential.response.signature)) : undefined,
      userHandle: credential.response.userHandle ? toBase64Url(new Uint8Array(credential.response.userHandle)) : undefined,
      transports: credential.response.getTransports ? credential.response.getTransports() : undefined
    }
  };
}

function normalizeRegistrationOptions(options) {
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    user: { ...options.user, id: fromBase64Url(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((cred) => ({ ...cred, id: fromBase64Url(cred.id) }))
  };
}

function normalizeAuthenticationOptions(options) {
  return {
    ...options,
    challenge: fromBase64Url(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((cred) => ({ ...cred, id: fromBase64Url(cred.id) }))
  };
}

async function refreshAdminDictionaryStatus(isAdmin) {
  if (!adminStatusBadge) return;
  if (!isAdmin) {
    adminStatusBadge.style.display = 'none';
    return;
  }

  try {
    const resp = await fetch('/api/library/dictionary');
    adminStatusBadge.style.display = 'block';
    if (resp.ok) {
      adminStatusBadge.textContent = 'Admin only: dictionary loaded';
      adminStatusBadge.classList.add('status-loaded');
      adminStatusBadge.classList.remove('status-missing');
      return;
    }
  } catch (e) {
    // fall through to missing state
  }

  adminStatusBadge.textContent = 'Admin only: dictionary missing';
  adminStatusBadge.classList.add('status-missing');
  adminStatusBadge.classList.remove('status-loaded');
}

function applyFontFamily(value) {
  const trimmed = value.trim();
  if (!trimmed) return;
  if (trimmed === 'custom' || trimmed === 'Custom...') return;
  document.documentElement.style.setProperty('--blog-font-family', trimmed);
}

function applyFontSize(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return;
  const size = trimmed.endsWith('px') ? trimmed : `${trimmed}px`;
  document.documentElement.style.setProperty('--blog-font-size', size);
}

async function loadPreferences() {
  try {
    const resp = await fetch('/api/settings');
    if (!resp.ok) return;
    const obj = await resp.json();
    if (obj.fontFamily) {
      document.documentElement.style.setProperty('--blog-font-family', obj.fontFamily);
      if (fontFamilyInput) {
        const options = Array.from(fontFamilyInput.options).map((option) => option.value);
        if (options.includes(obj.fontFamily)) {
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
        const match = obj.fontSize.match(/^(\d+)px$/);
        fontSizeInput.value = match ? match[1] : obj.fontSize;
      }
    }
    if (supportUrlInput) supportUrlInput.value = obj.supportCashAppUrl || obj.supportUrl || '';
    if (venmoUrlInput) venmoUrlInput.value = obj.supportVenmoUrl || '';
    if (newSiteUrlInput && obj.newSiteUrl) newSiteUrlInput.value = obj.newSiteUrl;
  } catch (e) {
    // ignore
  }
}

async function savePreferencesToServer() {
  const fontFamily = document.documentElement.style.getPropertyValue('--blog-font-family').trim();
  const fontSize = document.documentElement.style.getPropertyValue('--blog-font-size').trim();
  const supportCashAppUrl = supportUrlInput ? supportUrlInput.value.trim() : '';
  const supportVenmoUrl = venmoUrlInput ? venmoUrlInput.value.trim() : '';
  const newSiteUrl = newSiteUrlInput ? newSiteUrlInput.value.trim() : '';
  try {
    const resp = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fontFamily,
        fontSize,
        supportUrl: supportCashAppUrl,
        supportCashAppUrl,
        supportVenmoUrl,
        newSiteUrl
      })
    });
    const body = await resp.json();
    if (!resp.ok) {
      setStatus(body.error || 'Failed to save preferences to server.');
      return;
    }
    setStatus('Preferences saved to server.');
    await checkAdminSession();
  } catch (e) {
    setStatus('Failed to save preferences to server.');
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

async function sendSmsCode() {
  if (!pendingMfaToken) return false;
  const phoneNumber = adminPhoneNumberInput ? adminPhoneNumberInput.value.trim() : '';
  const resp = await fetch('/api/admin/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mfaToken: pendingMfaToken, phoneNumber })
  });
  const body = await resp.json();
  if (!resp.ok) {
    setStatus(body.error || 'Could not send text code.');
    return false;
  }
  setStatus(body.fallback && body.fallbackCode
    ? `SMS fallback active. Use code ${body.fallbackCode} to finish login.`
    : `Text code sent to ${body.destination || phoneNumber}. Enter the code to finish login.`);
  return true;
}

async function completePendingPhoneVerification() {
  if (!pendingMfaToken) return;
  const code = adminPhoneCodeInput ? adminPhoneCodeInput.value.trim() : '';
  if (!code) {
    setStatus('Enter your phone verification code.');
    return;
  }
  const resp = await fetch('/api/admin/sms/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mfaToken: pendingMfaToken, code })
  });
  const body = await resp.json();
  if (!resp.ok) {
    setStatus(body.error || 'Phone verification failed.');
    return;
  }
  pendingMfaToken = null;
  setStatus('Admin logged in with Samsung Pass fingerprint and text code.');
  await checkAdminSession();
}

async function connectSamsungPass() {
  if (!window.PublicKeyCredential) {
    setStatus('Use Samsung Internet or Chrome with Samsung Wallet/Samsung Pass enabled.');
    return false;
  }

  if (!/Android/i.test(navigator.userAgent || '')) {
    setStatus('Open this admin page on your Samsung phone. Desktop browsers will not show Samsung Pass fingerprint prompts.');
    return false;
  }

  if (window.location.hostname !== 'localhost') {
    setStatus('Open the admin page at http://localhost:3000/admin for Samsung Pass enrollment.');
    return false;
  }

  try {
    const optionsResp = await fetch('/api/admin/passkey/register/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const optionsBody = await optionsResp.json();
    if (!optionsResp.ok) {
      setStatus(optionsBody.error || 'Could not start Samsung Pass connection.');
      return false;
    }

    const credential = await navigator.credentials.create({ publicKey: normalizeRegistrationOptions(optionsBody) });
    if (!credential) {
      setStatus('Samsung Pass connection was canceled.');
      return false;
    }

    const verifyResp = await fetch('/api/admin/passkey/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: encodeCredentialForJson(credential) })
    });
    const verifyBody = await verifyResp.json();
    if (!verifyResp.ok) {
      setStatus(verifyBody.error || 'Samsung Pass connection failed.');
      return false;
    }

    setStatus('Samsung Pass connected on this phone.');
    return true;
  } catch (e) {
    setStatus(formatAuthError(e, 'Samsung Pass connection failed.'));
    return false;
  }
}

async function adminLogin() {
  try {
    const resp = await fetch('/api/admin/login/venmo-qr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const body = await resp.json();
    if (!resp.ok) {
      setStatus(body.error || 'Venmo QR login failed.');
      return;
    }
    setStatus('Logged in with Venmo QR.');
    await checkAdminSession();
  } catch (e) {
    setStatus(formatAuthError(e, 'Venmo QR login failed.'));
  }
}

async function adminLogout() {
  try {
    const resp = await fetch('/api/admin/logout', { method: 'POST' });
    if (!resp.ok) {
      setStatus('Logout failed.');
      return;
    }
    setStatus('Logged out.');
    await checkAdminSession();
  } catch (e) {
    setStatus('Logout failed.');
  }
}

async function checkAdminSession() {
  try {
    const resp = await fetch('/api/admin/session');
    if (!resp.ok) {
      if (adminLoginButton) adminLoginButton.style.display = 'inline-block';
      if (adminLogoutButton) adminLogoutButton.style.display = 'none';
      if (connectSamsungPassRow) connectSamsungPassRow.style.display = 'none';
      if (adminConfigPanel) adminConfigPanel.style.display = 'none';
      await refreshAdminDictionaryStatus(false);
      return;
    }
    const obj = await resp.json();
    if (obj.authenticated) {
      if (adminLoginButton) adminLoginButton.style.display = 'none';
      if (adminLogoutButton) adminLogoutButton.style.display = 'inline-block';
      if (connectSamsungPassRow) connectSamsungPassRow.style.display = 'flex';
      if (adminConfigPanel) adminConfigPanel.style.display = 'block';
      await refreshAdminDictionaryStatus(true);
    } else {
      if (adminLoginButton) adminLoginButton.style.display = 'inline-block';
      if (adminLogoutButton) adminLogoutButton.style.display = 'none';
      if (connectSamsungPassRow) connectSamsungPassRow.style.display = 'none';
      if (adminConfigPanel) adminConfigPanel.style.display = 'none';
      await refreshAdminDictionaryStatus(false);
    }
  } catch (e) {
    if (adminLoginButton) adminLoginButton.style.display = 'inline-block';
    if (adminLogoutButton) adminLogoutButton.style.display = 'none';
    if (connectSamsungPassRow) connectSamsungPassRow.style.display = 'none';
    if (adminConfigPanel) adminConfigPanel.style.display = 'none';
    await refreshAdminDictionaryStatus(false);
  }
}

if (fontFamilyInput) {
  fontFamilyInput.addEventListener('change', () => {
    const value = fontFamilyInput.value;
    if (value === 'custom') {
      if (fontFamilyCustomInput) fontFamilyCustomInput.style.display = 'block';
      if (fontFamilyCustomInput) applyFontFamily(fontFamilyCustomInput.value.trim());
      return;
    }
    if (fontFamilyCustomInput) fontFamilyCustomInput.style.display = 'none';
    applyFontFamily(value);
  });
}
if (fontFamilyCustomInput) {
  fontFamilyCustomInput.addEventListener('input', () => applyFontFamily(fontFamilyCustomInput.value.trim()));
}
if (fontSizeInput) fontSizeInput.addEventListener('input', () => applyFontSize(fontSizeInput.value.trim()));
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

loadPreferences();
checkAdminSession();
loadSmsProviderStatus();