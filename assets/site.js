// ronna.mom: the only script on the site. No network calls, no storage.
//
// The waitlist form is not connected anywhere until the CISO clears a
// destination in the CPO chat. Until then submit is held here, and the
// Content-Security-Policy in /_headers (form-action 'none') blocks it in
// the browser as a second guard.
(function () {
  var form = document.querySelector("form[data-waitlist]");
  if (!form) return;
  var notice = document.getElementById("waitlist-notice");
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (notice) notice.hidden = false;
  });
})();
