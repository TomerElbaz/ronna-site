// ronna.mom: the only script on the site. No network calls, no storage.
//
// The waitlist form is not connected anywhere until the CISO clears a
// destination in the CPO chat. Until then submit is held here: a valid
// email moves the page to the confirm step locally and the field is
// cleared, so the address goes nowhere and is not kept. The
// Content-Security-Policy in /_headers (form-action 'none') blocks the
// submit in the browser as a second guard.
//
// The place on the list is its own page, /confirm/, where the confirm
// email's link lands. This script never runs there.
(function () {
  var join = document.querySelector("[data-join]");
  if (!join) return;
  var form = join.querySelector("form[data-waitlist]");
  var email = form && form.elements.email;
  var error = document.getElementById("waitlist-error");
  var steps = {};
  Array.prototype.forEach.call(join.querySelectorAll("[data-step]"), function (el) {
    steps[el.getAttribute("data-step")] = el;
  });

  function show(name) {
    Object.keys(steps).forEach(function (key) {
      steps[key].hidden = key !== name;
    });
    if (name !== "form") steps[name].focus();
  }

  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!email.value.trim() || !email.checkValidity()) {
        error.hidden = false;
        email.setAttribute("aria-invalid", "true");
        email.focus();
        return;
      }
      error.hidden = true;
      email.removeAttribute("aria-invalid");
      email.value = "";
      show("confirm");
    });
  }

  var resend = join.querySelector("[data-resend]");
  var resent = join.querySelector("[data-resent]");
  if (resend && resent) {
    resend.addEventListener("click", function () {
      resent.hidden = false;
    });
  }
})();
