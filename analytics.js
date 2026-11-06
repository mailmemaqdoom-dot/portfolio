// Privacy-limited page and click counts. No cookies, no storage, no fingerprinting.
// Respects Do Not Track. Sends only path, referrer host, campaign tags and clicks on
// elements marked with data-track. The collect function drops IP address and user agent.
(function () {
  'use strict';
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
  if (location.pathname.indexOf('/admin') === 0) return;

  var ENDPOINT = 'https://vafhjanttehbbtfrbkcs.supabase.co/functions/v1/collect';

  // text/plain keeps the request "simple", so the browser sends no pre-flight check.
  function send(payload) {
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }));
      } else {
        fetch(ENDPOINT, { method: 'POST', body: body, headers: { 'content-type': 'text/plain' }, keepalive: true });
      }
    } catch (e) { /* analytics must never affect the page */ }
  }

  var params = new URLSearchParams(location.search);
  send({
    type: 'pageview',
    path: location.pathname,
    referrer: document.referrer || '',
    utm_source: params.get('utm_source') || '',
    utm_medium: params.get('utm_medium') || '',
    utm_campaign: params.get('utm_campaign') || ''
  });

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-track]') : null;
    if (!el) return;
    send({ type: 'click', click_target: el.getAttribute('data-track'), path: location.pathname });
  }, true);
})();
