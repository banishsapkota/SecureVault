// Applies the saved colour theme before the page paints (avoids a flash of the wrong theme).
(function () {
    'use strict';
    let theme = null;
    try { theme = localStorage.getItem('sv-theme'); } catch (e) { theme = null; }
    if (theme !== 'light' && theme !== 'dark') {
        theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', theme);
})();
