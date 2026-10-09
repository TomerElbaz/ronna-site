// ronna.mom: the only script on the site. It talks to one place only, this
// site's own /api/ (the waitlist Worker; CSP connect-src 'self'), and keeps
// nothing in storage. Built to CISO rules 69, 72 and 74.
//
// - Tokens and invite codes arrive after "#" in links, so they never reach a
//   server in a URL. This script reads them, clears them from the address
//   bar at once, and sends them only in POST bodies (rule 72.3).
// - Names are always inserted as text, never as HTML (rule 74.5).
// - Every reply about an address is the same (rule 69.4): the page says
//   "Check your email." whether the address is new or already on the list.
(function () {
  "use strict";

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        return { status: res.status, body: json || {} };
      });
    }, function () {
      return { status: 0, body: {} };
    });
  }

  // Read "#name=value" once and clear it from the address bar.
  function takeFragment(name) {
    var m = location.hash.match(new RegExp("^#" + name + "=([^&]+)$"));
    if (location.hash) history.replaceState(null, "", location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function steps(root) {
    var all = {};
    Array.prototype.forEach.call(root.querySelectorAll("[data-step]"), function (el) {
      all[el.getAttribute("data-step")] = el;
    });
    var heading = root.querySelector("[data-heading]");
    return function show(name, focus) {
      Object.keys(all).forEach(function (k) { all[k].hidden = k !== name; });
      // One h1 per page; each state names its own title.
      if (heading && all[name] && all[name].getAttribute("data-title")) heading.textContent = all[name].getAttribute("data-title");
      if (focus !== false && all[name] && name !== "form") all[name].focus();
    };
  }

  function invalid(input, error) {
    error.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.focus();
  }

  function valid(input, error) {
    error.hidden = true;
    input.removeAttribute("aria-invalid");
  }

  function emailOk(input) {
    return input.value.trim() !== "" && input.checkValidity();
  }

  // ---------- the waitlist form on / and /what/ ----------
  var join = document.querySelector("[data-join]");
  if (join) {
    var show = steps(join);
    var form = join.querySelector("form[data-waitlist]");
    var email = form.elements.email;
    var error = document.getElementById("waitlist-error");
    var failed = join.querySelector("[data-failed]");
    var lastEmail = null; // kept in memory only, for "Send the link again"
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!emailOk(email)) return invalid(email, error);
      valid(email, error);
      lastEmail = email.value.trim();
      var honeypot = form.elements.website ? form.elements.website.value : "";
      post("/api/signup", { email: lastEmail, website: honeypot }).then(function (r) {
        if (r.status === 202) {
          email.value = "";
          if (failed) failed.hidden = true;
          show("confirm");
        } else if (failed) {
          failed.hidden = false;
        }
      });
    });
    var resend = join.querySelector("[data-resend]");
    var resent = join.querySelector("[data-resent]");
    if (resend && resent) {
      resend.addEventListener("click", function () {
        if (!lastEmail) return;
        post("/api/signup", { email: lastEmail }).then(function () { resent.hidden = false; });
      });
    }
  }

  // ---------- /confirm/: #t=<token>, spent only on a click ----------
  var confirmRoot = document.querySelector("[data-confirm]");
  if (confirmRoot) {
    var showC = steps(confirmRoot);
    var token = takeFragment("t");
    if (!token) {
      showC("none", false);
    } else {
      showC("ready", false);
      confirmRoot.querySelector("[data-confirm-button]").addEventListener("click", function () {
        post("/api/confirm", { token: token }).then(function (r) {
          token = null;
          if (r.body && r.body.ok) {
            confirmRoot.querySelector("[data-place]").textContent = "#" + String(r.body.place);
            showC("done");
          } else {
            showC("bad");
          }
        });
      });
    }
  }

  // ---------- /off/: #d=<token> deletes in one click; otherwise a request form ----------
  var offRoot = document.querySelector("[data-off]");
  if (offRoot) {
    var showO = steps(offRoot);
    var del = takeFragment("d");
    if (del) {
      showO("working", false);
      post("/api/delete", { token: del }).then(function (r) {
        showO(r.body && r.body.ok ? "deleted" : "bad");
      });
    } else {
      showO("form", false);
      var offForm = offRoot.querySelector("form[data-off-form]");
      var offEmail = offForm.elements.email;
      var offError = document.getElementById("off-error");
      offForm.addEventListener("submit", function (event) {
        event.preventDefault();
        if (!emailOk(offEmail)) return invalid(offEmail, offError);
        valid(offEmail, offError);
        post("/api/delete-request", { email: offEmail.value.trim() }).then(function (r) {
          if (r.status === 202) {
            offEmail.value = "";
            showO("sent");
          }
        });
      });
    }
  }

  // ---------- /invite/: #code=<code> or typed; POST bodies only ----------
  var inviteRoot = document.querySelector("[data-invite]");
  if (inviteRoot) {
    var showI = steps(inviteRoot);
    var codeForm = inviteRoot.querySelector("form[data-code-form]");
    var codeInput = codeForm.elements.code;
    var codeError = document.getElementById("code-error");
    var joinForm = inviteRoot.querySelector("form[data-invite-join]");
    var inviteEmail = joinForm.elements.email;
    var inviteEmailError = document.getElementById("invite-email-error");
    var badLine = inviteRoot.querySelector("[data-bad]");
    var code = takeFragment("code");

    function badCode(message) {
      badLine.textContent = message || "This invite isn't valid.";
      showI("code");
      badLine.hidden = false;
      codeInput.focus();
    }

    function lookUp(value) {
      badLine.hidden = true;
      post("/api/invite/lookup", { code: value }).then(function (r) {
        if (r.body && r.body.ok && typeof r.body.invitedBy === "string") {
          code = value;
          inviteRoot.querySelector("[data-invited-by]").textContent = r.body.invitedBy;
          showI("join");
        } else {
          code = null;
          badCode(r.body && r.body.message);
        }
      });
    }

    codeForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var value = codeInput.value.trim();
      if (value.replace(/[\s-]/g, "").length !== 16) return invalid(codeInput, codeError);
      valid(codeInput, codeError);
      lookUp(value);
    });

    joinForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!emailOk(inviteEmail)) return invalid(inviteEmail, inviteEmailError);
      valid(inviteEmail, inviteEmailError);
      var honeypot = joinForm.elements.website ? joinForm.elements.website.value : "";
      post("/api/invite/redeem", { code: code, email: inviteEmail.value.trim(), website: honeypot }).then(function (r) {
        if (r.status === 202) {
          inviteEmail.value = "";
          code = null;
          codeInput.value = "";
          showI("sent");
        } else if (r.body && r.body.message) {
          code = null;
          badCode(r.body.message);
        }
      });
    });

    if (code) lookUp(code);
    else showI("code", false);
  }

  // ---------- /family/: behind Cloudflare Access ----------
  var familyRoot = document.querySelector("[data-family]");
  if (familyRoot) {
    var showF = steps(familyRoot);
    var list = familyRoot.querySelector("[data-codes]");
    var newCodeBox = familyRoot.querySelector("[data-new-code]");
    var newCodeText = familyRoot.querySelector("[data-new-code-text]");
    var mintButton = familyRoot.querySelector("[data-mint]");
    var mintNote = familyRoot.querySelector("[data-mint-note]");
    var nameForm = familyRoot.querySelector("form[data-name-form]");
    var nameError = document.getElementById("name-error");
    var enrolForm = familyRoot.querySelector("form[data-enrol-form]");
    var enrolError = document.getElementById("enrol-error");

    function fmtDate(ms) {
      return new Date(ms).toISOString().slice(0, 10);
    }

    function render(state) {
      if (!state.enrolled) return showF("enrol", false);
      showF("family", false);
      familyRoot.querySelector("[data-family-name]").textContent = state.name || "(not set)";
      nameForm.elements.name.value = state.name || "";
      list.textContent = "";
      state.codes.forEach(function (c) {
        var li = document.createElement("li");
        var label = document.createElement("span");
        label.textContent = (c.state === "used" ? "Used" : "Unused") + (c.state === "unused" ? " · expires " + fmtDate(c.expiresAt) : "");
        li.appendChild(label);
        if (c.state === "unused") {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "btn btn--ghost btn--small";
          b.textContent = "Revoke";
          b.addEventListener("click", function () {
            post("/api/family/revoke", { id: c.id }).then(refresh);
          });
          li.appendChild(b);
        }
        list.appendChild(li);
      });
      if (!state.codes.length) {
        var none = document.createElement("li");
        none.textContent = "No codes yet.";
        list.appendChild(none);
      }
    }

    function refresh() {
      return post("/api/family/status", {}).then(function (r) {
        if (r.status === 200 && r.body.ok) render(r.body);
        else showF("denied", false);
      });
    }

    enrolForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var v = enrolForm.elements.code.value.trim();
      if (v.replace(/[\s-]/g, "").length !== 16) return invalid(enrolForm.elements.code, enrolError);
      post("/api/family/enrol", { code: v }).then(function (r) {
        if (r.body && r.body.ok) {
          enrolForm.elements.code.value = "";
          valid(enrolForm.elements.code, enrolError);
          refresh();
        } else {
          invalid(enrolForm.elements.code, enrolError);
        }
      });
    });

    nameForm.addEventListener("submit", function (event) {
      event.preventDefault();
      post("/api/family/name", { name: nameForm.elements.name.value }).then(function (r) {
        if (r.body && r.body.ok) {
          valid(nameForm.elements.name, nameError);
          refresh();
        } else {
          invalid(nameForm.elements.name, nameError);
        }
      });
    });

    mintButton.addEventListener("click", function () {
      mintNote.hidden = true;
      post("/api/family/mint", {}).then(function (r) {
        if (r.body && r.body.ok) {
          // Shown once (rule 72.2): it lives only in this element until the page changes.
          newCodeText.textContent = r.body.code;
          newCodeBox.hidden = false;
          newCodeBox.focus();
          refresh();
        } else {
          mintNote.textContent = r.body && r.body.error === "cap" ? "You have 5 live codes. Revoke one or wait until one is used or expires."
            : r.body && r.body.error === "name" ? "Choose a first name first."
            : r.body && r.body.error === "daily" ? "That's 20 codes today. Try again tomorrow."
            : "That didn't work. Try again.";
          mintNote.hidden = false;
        }
      });
    });

    var copy = familyRoot.querySelector("[data-copy]");
    if (copy && navigator.clipboard) {
      copy.addEventListener("click", function () {
        navigator.clipboard.writeText(newCodeText.textContent).then(function () { copy.textContent = "Copied"; });
      });
    }
    var hide = familyRoot.querySelector("[data-hide-code]");
    if (hide) {
      hide.addEventListener("click", function () {
        newCodeText.textContent = "";
        newCodeBox.hidden = true;
        if (copy) copy.textContent = "Copy";
      });
    }

    refresh();
  }
})();
