(function () {
  var styleId = 'mpb-global-nav-style';
  if (!document.getElementById(styleId)) {
    var style = document.createElement('style');
    style.id = styleId;
    style.textContent = [
      '.mpb-global-nav-wrap{position:sticky;top:0;z-index:1200;padding:10px 12px;background:rgba(8,18,36,0.92);backdrop-filter:blur(6px);border-bottom:1px solid rgba(255,255,255,0.12);}',
      '.mpb-global-nav{max-width:1200px;margin:0 auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
      '.mpb-global-nav a{display:inline-flex;align-items:center;justify-content:center;padding:7px 12px;border-radius:999px;text-decoration:none;font-size:0.85rem;line-height:1.2;font-weight:700;color:#eaf2ff;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.18);}',
      '.mpb-global-nav a:hover{background:rgba(255,255,255,0.2);}',
      '.mpb-global-nav a.active{background:#9b1c31;border-color:#9b1c31;color:#fff;}',
      '@media (max-width:640px){.mpb-global-nav a{font-size:0.78rem;padding:6px 10px;}}'
    ].join('');
    document.head.appendChild(style);
  }

  if (document.querySelector('.mpb-global-nav-wrap')) return;

  var links = [
    { href: '/page1', label: 'Blog Page 1' },
    { href: '/page2', label: 'Blog Page 2' },
    { href: '/page3', label: 'Blog Page 3' },
    { href: '/page4', label: 'Blog Page 4' },
    { href: '/page5', label: 'Blog Page 5' },
    { href: '/page6', label: 'Blog Page 6' },
    { href: '/page7', label: 'Blog Page 7' },
    { href: '/tools.html', label: 'Tools' },
    { href: '/library', label: 'Library' },
    { href: '/encyclopedia', label: 'Encyclopedia' },
    { href: '/word-parts', label: 'Word Parts' },
    { href: '/dreamstate', label: 'Dream State' },
    { href: '/calendar-journal', label: 'Calendar' },
    { href: '/published', label: 'Public' },
    { href: '/support', label: 'Support' },
    { href: '/resume', label: 'Resume' },
    { href: '/alarm', label: 'Alarm' },
    { href: '/calculator.html', label: 'Calculator' },
    { href: '/admin', label: 'Admin' },
    { href: '/login', label: 'Login' }
  ];

  var currentPath = window.location.pathname || '/';
  if (currentPath === '/') currentPath = '/page1';

  var wrap = document.createElement('div');
  wrap.className = 'mpb-global-nav-wrap';

  var nav = document.createElement('nav');
  nav.className = 'mpb-global-nav';
  nav.setAttribute('aria-label', 'Global site navigation');

  links.forEach(function (item) {
    var a = document.createElement('a');
    a.href = item.href;
    a.textContent = item.label;
    if (currentPath === item.href) a.classList.add('active');
    nav.appendChild(a);
  });

  wrap.appendChild(nav);
  document.body.insertBefore(wrap, document.body.firstChild);
})();
