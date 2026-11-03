// Community United Network client. No build step; uses textContent everywhere so user text is never parsed as HTML.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { me: null };

const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const toCents = (dollars) => Math.round(Number(dollars) * 100);
const splitList = (text) =>
  String(text || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "onclick") node.addEventListener("click", value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Appends only real nodes, so a null from a conditional does not render as the text "null". */
function appendAll(parent, ...nodes) {
  parent.append(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
}

function notify(message, kind = "ok") {
  const n = $("#notice");
  n.textContent = message;
  n.className = kind;
}

async function api(path, { method, body } = {}) {
  const res = await fetch(path, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.details) ? data.details.map((d) => d.message).join("; ") : "";
    throw new Error(detail || data.error || `Request failed (${res.status})`);
  }
  return data;
}

async function run(action, successMessage) {
  try {
    const result = await action();
    if (successMessage) notify(successMessage, "ok");
    return result;
  } catch (err) {
    notify(err.message, "error");
    return undefined;
  }
}

const PAGES = ["browse", "matches", "mine", "post", "profile", "members", "messages", "admin"];
const nav = { current: null, trail: [], popping: false };

/** Opens a tab as its own page. The address changes too, so the phone's back gesture works. */
function showView(name) {
  if (!PAGES.includes(name)) name = "browse";
  if (location.hash !== "#" + name) {
    location.hash = name; // the hashchange listener below draws the page
  } else {
    renderView(name);
  }
}

function renderView(name) {
  if (!PAGES.includes(name)) name = "browse";
  if (!nav.popping && nav.current && nav.current !== name) {
    nav.trail.push(nav.current);
    if (nav.trail.length > 20) nav.trail.shift();
  }
  nav.popping = false;
  nav.current = name;
  $$(".view").forEach((v) => (v.hidden = v.id !== name));
  window.scrollTo({ top: 0 });
  if (name === "browse") loadBrowse();
  if (name === "matches") loadMatches();
  if (name === "mine") loadMine();
  if (name === "profile") loadProfile();
  if (name === "admin") loadAdmin();
  if (name === "members") loadMembers();
  if (name === "messages") loadConversations();
  if (name === "post") $("#post-form").scrollIntoView({ block: "start" });
}

/** Back button on every tab page: returns to the page you came from. */
function goBack() {
  const prev = nav.trail.pop() || "browse";
  nav.popping = true;
  if (location.hash !== "#" + prev) location.hash = prev;
  else renderView(prev);
}

window.addEventListener("hashchange", () => {
  if (!state.me) return;
  renderView(location.hash.slice(1) || "browse");
});

$$("[data-back]").forEach((b) => b.addEventListener("click", goBack));

function setLoggedIn(on) {
  $("#nav").hidden = !on;
  if (!on) {
    $$(".view").forEach((v) => (v.hidden = v.id !== "auth"));
  }
}

// ---------- auth ----------

async function loadFounders() {
  try {
    const data = await api("/api/founders");
    if (!data.founders.length) return;
    const box = $("#founders-list");
    box.replaceChildren();
    for (const f of data.founders) {
      box.append(el("div", { class: "founder" }, el("strong", {}, f.display_name), el("span", {}, f.founder_title)));
    }
    $("#founders").hidden = false;
  } catch {
    // The front page still works without the founders list.
  }
}

async function boot() {
  loadFounders();
  try {
    state.me = await api("/api/me");
    setLoggedIn(true);
    $("#admin-nav").hidden = !state.me.is_admin;
    const start = location.hash.slice(1);
    showView(PAGES.includes(start) ? start : "browse");
    await handleReturns();
  } catch {
    state.me = null;
    setLoggedIn(false);
  }
}

$("#toggle-auth").addEventListener("click", () => {
  const registering = $("#register-form").hidden;
  $("#register-form").hidden = !registering;
  $("#login-form").hidden = registering;
  $("#auth-title").textContent = registering ? "Create account" : "Log in";
  $("#toggle-auth").textContent = registering ? "I already have an account" : "Create an account";
});

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const ok = await run(() => api("/api/auth/login", { body: { email: f.get("email"), password: f.get("password") } }));
  if (ok) await boot();
});

$("#register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = Object.fromEntries(f.entries());
  const ok = await run(() => api("/api/auth/register", { body }));
  if (ok) {
    await boot();
    notify("Welcome! Verify your identity before you accept paid tasks.", "ok");
  }
});

$("#logout").addEventListener("click", async () => {
  await run(() => api("/api/auth/logout", { body: {} }));
  state.me = null;
  setLoggedIn(false);
  notify("You have logged out.", "ok");
});

$$("nav button[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

// ---------- browse / matches ----------

function taskCard(task, actions = []) {
  const typeLabel = task.help_type === "volunteer" ? "Volunteer" : `${money(task.price_cents)} per helper`;
  return el(
    "article",
    { class: "card" },
    el("h3", {}, task.title),
    el("div", { class: "meta" }, `${task.category || ""} · ${task.city}${task.zip ? ` ${task.zip}` : ""} · ${typeLabel}`),
    task.reasons?.length ? el("div", {}, ...task.reasons.map((r) => el("span", { class: "pill" }, r))) : null,
    task.status ? el("div", { class: "meta" }, `Status: ${task.status.replaceAll("_", " ")}`) : null,
    el("div", { class: "actions" }, actions),
  );
}

async function loadBrowse() {
  const params = new URLSearchParams();
  for (const [k, v] of new FormData($("#filter-form")).entries()) if (v) params.set(k, v);
  const data = await run(() => api(`/api/tasks?${params}`));
  const list = $("#browse-list");
  list.replaceChildren();
  if (!data) return;
  if (data.tasks.length === 0) list.append(el("p", { class: "hint" }, "No open tasks match these filters yet."));
  for (const t of data.tasks) {
    list.append(
      taskCard(t, [
        el("button", { type: "button", onclick: () => acceptTask(t.id) }, "I can do this"),
        el("button", { type: "button", class: "secondary", onclick: () => openDetail(t.id) }, "Details"),
      ]),
    );
  }
}

$("#filter-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loadBrowse();
});

async function acceptTask(id) {
  const res = await run(() => api(`/api/tasks/${id}/accept`, { body: {} }), "You're on the task. The requester has been notified.");
  if (res) loadBrowse();
}

async function loadMatches() {
  const data = await run(() => api("/api/me/matches"));
  const list = $("#matches-list");
  list.replaceChildren();
  if (!data) return;
  if (data.matches.length === 0) list.append(el("p", { class: "hint" }, "No matches yet. Add skills and tools to your profile."));
  for (const t of data.matches) {
    list.append(
      taskCard(t, [
        el("button", { type: "button", onclick: () => acceptTask(t.id) }, "I can do this"),
        el("button", { type: "button", class: "secondary", onclick: () => openDetail(t.id) }, "Details"),
      ]),
    );
  }
}

// ---------- my tasks & detail ----------

async function loadMine() {
  const data = await run(() => api("/api/tasks/mine"));
  const list = $("#mine-list");
  list.replaceChildren();
  if (!data) return;
  if (data.tasks.length === 0) list.append(el("p", { class: "hint" }, "You have no tasks yet."));
  for (const t of data.tasks) {
    list.append(
      taskCard(
        { ...t, city: t.city, reasons: [t.is_requester ? "Requested by you" : "Helping"] },
        [el("button", { type: "button", class: "secondary", onclick: () => openDetail(t.id) }, "Open")],
      ),
    );
  }
}

async function openDetail(id) {
  const task = await run(() => api(`/api/tasks/${id}`));
  if (!task) return;
  const isRequester = task.viewer_role === "requester";
  const isHelper = task.viewer_role === "helper";
  const isAdmin = task.viewer_role === "admin";
  const isParty = isRequester || isHelper || isAdmin;
  const panel = $("#task-detail");
  // Remember which list the task was opened from, so "Back" returns there.
  const currentView = $$(".view").find((v) => !v.hidden)?.id;
  if (["browse", "matches", "mine"].includes(currentView)) state.returnView = currentView;
  panel.hidden = false;
  panel.replaceChildren();
  panel.append(
    el(
      "button",
      {
        type: "button",
        class: "secondary",
        onclick: () => {
          panel.hidden = true;
          showView(state.returnView || "mine");
        },
      },
      "← Back to list",
    ),
  );

  appendAll(
    panel,
    el("h3", {}, task.title),
    el("p", {}, task.description),
    el(
      "div",
      { class: "meta" },
      `Status: ${task.status.replaceAll("_", " ")} · ${task.city} ${task.zip} · ${task.schedule_type.replaceAll("_", " ")}`,
    ),
    el(
      "div",
      { class: "meta" },
      task.help_type === "volunteer"
        ? "Volunteer task"
        : `Paid: ${money(task.price_cents)} per helper · helper receives ${money(task.helper_net_cents)} after the 10% platform fee`,
    ),
    el("div", { class: "meta" }, `Helpers: ${task.active_helpers} of ${task.helpers_needed} · Open slots: ${task.open_slots}`),
    task.supplies_note ? el("div", { class: "meta" }, `Supplies: ${task.supplies_note}`) : null,
    task.address_private ? el("div", { class: "meta" }, `Address (shared with people on this task): ${task.address_private}`) : null,
    task.held_cents !== undefined ? el("div", { class: "meta" }, `Held in escrow: ${money(task.held_cents)}`) : null,
    task.help_type === "paid" && !task.funded
      ? el("div", { class: "warn" }, isRequester ? "Not paid yet. Helpers can't accept this task until you pay." : "Not paid yet. The requester needs to pay before anyone can accept.")
      : null,
  );

  if (Array.isArray(task.assignments) && task.assignments.length) {
    panel.append(el("h4", {}, "People on this task"));
    for (const a of task.assignments) {
      panel.append(el("div", { class: "meta" }, `${a.display_name} · ${a.status}`));
    }
  }

  // Pending change requests: the side that did not ask approves.
  const pending = (task.change_requests || []).filter((c) => c.status === "pending");
  if (pending.length) {
    panel.append(el("h4", {}, "Change requests"));
    for (const c of pending) {
      const askedByMe = c.requested_by === state.me.id;
      panel.append(
        el(
          "div",
          { class: "card" },
          el("div", {}, `${c.kind.replaceAll("_", " ")}: ${JSON.stringify(c.proposed)}`),
          c.reason ? el("div", { class: "meta" }, `Reason: ${c.reason}`) : null,
          askedByMe
            ? el("div", { class: "meta" }, "Waiting for the other party to respond.")
            : el(
                "div",
                { class: "actions" },
                el("button", { type: "button", onclick: () => decideChange(c.id, true, id) }, "Approve"),
                el("button", { type: "button", class: "danger", onclick: () => decideChange(c.id, false, id) }, "Decline"),
              ),
        ),
      );
    }
  }

  if (isParty) panel.append(actionPanel(task, { isRequester, isHelper, isAdmin }));
  if (isAdmin) panel.append(adminResolvePanel(task));
  if (isRequester) await appendCandidates(panel, id);

  panel.scrollIntoView({ block: "start" });
  $$(".view").forEach((v) => (v.hidden = v.id !== "mine"));
}

async function appendCandidates(panel, id) {
  const data = await run(() => api(`/api/tasks/${id}/candidates`));
  if (!data || data.candidates.length === 0) return;
  panel.append(el("h4", {}, "Helpers who may fit (best first)"));
  for (const c of data.candidates.slice(0, 15)) {
    panel.append(
      el(
        "div",
        { class: "card" },
        el("strong", {}, c.display_name),
        el("div", { class: "meta" }, `${c.verified ? "Verified" : "Not yet verified"} · ${c.city || ""} ${c.zip || ""}`),
        el("div", {}, ...c.reasons.map((r) => el("span", { class: "pill" }, r))),
      ),
    );
  }
}

async function decideChange(changeId, approve, taskId) {
  const verb = approve ? "approve" : "decline";
  const res = await run(() => api(`/api/tasks/changes/${changeId}/${verb}`, { body: {} }), `Change ${approve ? "approved" : "declined"}.`);
  if (res) openDetail(taskId);
}

function actionButton(label, onclick, cls = "") {
  return el("button", { type: "button", class: cls, onclick }, label);
}

function actionPanel(task, { isRequester, isHelper, isAdmin }) {
  const id = task.id;
  const s = task.status;
  const refresh = () => openDetail(id);
  const act = (path, body, msg) => run(() => api(`/api/tasks/${id}/${path}`, { body: body ?? {} }), msg).then((r) => r && refresh());

  const box = el("div", { class: "card" }, el("h4", {}, "Actions"));
  const buttons = [];

  if (isRequester && task.help_type === "paid" && !task.funded && ["open", "accepted", "continue_later"].includes(s)) {
    buttons.push(actionButton("Pay to publish this task", () => startPayment(id)));
  }

  if (isHelper && (s === "accepted" || s === "continue_later")) {
    buttons.push(actionButton("I've arrived, start work", () => act("start", {}, "Work started.")));
  }
  if (isHelper && s !== "awaiting_confirmation" && ["accepted", "in_progress", "continue_later"].includes(s)) {
    buttons.push(actionButton("Withdraw from task", () => act("withdraw", {}, "You have withdrawn."), "secondary"));
  }

  if ((isHelper || isRequester) && s === "in_progress") {
    const outcome = el(
      "select",
      { name: "outcome" },
      el("option", { value: "completed" }, "Completed"),
      el("option", { value: "partially_completed" }, "Partially completed"),
      el("option", { value: "continue_later" }, "Continue later"),
    );
    const earned = el("input", { type: "number", min: "0", step: "0.01", placeholder: "Earned per helper ($)" });
    box.append(el("label", {}, "How did it end?", outcome), el("label", {}, "Amount earned per helper, for partial or continue-later", earned));
    buttons.push(
      actionButton(
        "Submit outcome",
        () => {
          const body = { outcome: outcome.value };
          if (outcome.value !== "completed") body.earned_cents = toCents(earned.value || 0);
          return act("finish", body, "Outcome sent. The requester will confirm before payment is released.");
        },
      ),
    );
  }

  if (isRequester && s === "awaiting_confirmation") {
    box.append(el("p", {}, `Proposed outcome: ${task.proposed_outcome?.replaceAll("_", " ")}, ${money(task.proposed_earned_cents)} per helper.`));
    buttons.push(actionButton("Confirm and release payment", () => act("confirm", {}, "Payment released according to the agreement.")));
  }

  if ((isRequester || isHelper) && (s === "awaiting_confirmation" || s === "completed" || s === "partially_completed")) {
    buttons.push(actionButton("Raise a dispute", () => act("dispute", {}, "Dispute opened. An admin will review it."), "secondary"));
  }

  if (isRequester && ["open", "accepted", "in_progress", "continue_later"].includes(s)) {
    const exception = el("input", { type: "checkbox", id: "exception" });
    box.append(el("label", {}, exception, "Genuine emergency, safety, or severe weather (waives compensation)"));
    buttons.push(
      actionButton(
        "Cancel task",
        () => act("cancel", { exception: exception.checked }, "Task cancelled. Compensation and refunds were applied as agreed."),
        "danger",
      ),
    );
  }

  if (["accepted", "in_progress", "continue_later", "awaiting_confirmation"].includes(s)) {
    const desc = el("textarea", { rows: "3", maxlength: "4000", placeholder: "Describe the safety concern" });
    const stop = el("input", { type: "checkbox" });
    box.append(el("label", {}, "Safety concern", desc), el("label", {}, stop, "Stop the task now"));
    buttons.push(
      actionButton(
        "Report safety concern",
        () =>
          act("safety-reports", { description: desc.value, stop_task: stop.checked }, "Safety report sent to support, separate from payments."),
        "danger",
      ),
    );
  }

  if (["open", "accepted", "in_progress", "continue_later"].includes(s) && (isRequester || isHelper)) {
    const kind = el(
      "select",
      { name: "kind" },
      el("option", { value: "price" }, "Change price per helper"),
      el("option", { value: "helper_count" }, "Change number of helpers"),
      el("option", { value: "scope" }, "Change description"),
    );
    const value = el("input", { placeholder: "New price ($), helper count (one/two/three_plus), or description" });
    box.append(el("label", {}, "Request a change", kind, value));
    buttons.push(
      actionButton(
        "Send change request",
        () => {
          let proposed;
          if (kind.value === "price") proposed = { price_cents: toCents(value.value) };
          else if (kind.value === "helper_count") proposed = { helpers: value.value.trim() };
          else proposed = { description: value.value };
          return act("changes", { kind: kind.value, proposed }, "Change request sent to the other party.");
        },
        "secondary",
      ),
    );
  }

  if (isRequester && (s === "completed" || s === "partially_completed")) {
    const rating = el("select", { name: "rating" }, ...[5, 4, 3, 2, 1].map((n) => el("option", { value: n }, `${n} stars`)));
    const comment = el("input", { maxlength: "1000", placeholder: "Optional comment" });
    box.append(el("label", {}, "Rate the helper", rating, comment));
    buttons.push(
      actionButton("Submit review", () => {
        const subject = (task.assignments || []).find((a) => a.status === "completed");
        if (!subject) return notify("No completed helper to review.", "error");
        return run(
          () => api(`/api/tasks/${id}/reviews`, { body: { rating: Number(rating.value), comment: comment.value, subject_id: subject.helper_id } }),
          "Thanks for the review.",
        );
      }),
    );
  }

  if (buttons.length === 0) box.append(el("p", { class: "hint" }, "No actions are available right now."));
  box.append(el("div", { class: "actions" }, buttons));
  return box;
}

// ---------- post a task ----------

$("#post-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  const body = {
    title: f.title,
    description: f.description,
    category: f.category,
    required_skills: splitList(f.required_skills),
    tools_needed: splitList(f.tools_needed),
    city: f.city,
    state: f.state,
    zip: f.zip,
    address_private: f.address_private,
    schedule_type: f.schedule_type,
    scheduled_for: f.scheduled_for ? new Date(f.scheduled_for).toISOString() : undefined,
    schedule_note: f.schedule_note,
    helpers: f.helpers,
    help_type: f.help_type,
    price_cents: f.help_type === "volunteer" ? 0 : toCents(f.price),
    supplies_provided: f.supplies_provided,
    supplies_note: f.supplies_note,
  };
  const task = await run(() => api("/api/tasks", { body }), "Task posted. Requested amount is held in escrow.");
  if (task) {
    e.target.reset();
    openDetail(task.id);
  }
});

// ---------- profile ----------

async function loadProfile() {
  const p = await run(() => api("/api/me"));
  if (!p) return;
  const langSelect = $("#profile-form").elements.namedItem("language");
  if (!langSelect.options.length) {
    const { languages } = await api("/api/languages");
    for (const l of languages) langSelect.append(new Option(l.name, l.code));
  }
  langSelect.value = p.language || "en";
  const form = $("#profile-form");
  for (const [k, v] of Object.entries(p)) {
    const field = form.elements.namedItem(k);
    if (!field) continue;
    if (field.type === "checkbox") continue; // checked state is set separately below
    if (field.type === "radio") form.querySelectorAll(`[name="role_mode"]`).forEach((r) => (r.checked = r.value === v));
    else if (Array.isArray(v)) field.value = v.join(", ");
    else field.value = v ?? "";
  }
  $("#profile-form").elements.namedItem("profile_public").checked = Boolean(p.profile_public);
  $("#request-verify").hidden = !["unverified", "rejected"].includes(p.verification_status);
  loadPayouts();
  $("#verify-status").textContent =
    p.verification_status === "verified"
      ? "Identity verified. You can accept paid tasks."
      : `Verification status: ${p.verification_status}. Identity verification is required before you accept tasks.`;
}

$("#profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    display_name: f.get("display_name"),
    role_mode: f.get("role_mode") || undefined,
    city: f.get("city"),
    state: f.get("state"),
    zip: f.get("zip") || undefined,
    skills: splitList(f.get("skills")),
    tools: splitList(f.get("tools")),
    availability: f.get("availability"),
    bio: f.get("bio"),
    profile_public: f.get("profile_public") === "on",
    language: f.get("language") || undefined,
  };
  const res = await run(() => api("/api/me", { method: "PUT", body }), "Profile saved.");
  if (res) loadProfile();
});

$("#request-verify").addEventListener("click", async () => {
  const res = await run(() => api("/api/me/request-verification", { body: {} }), "Verification requested. An admin will review it.");
  if (res) loadProfile();
});

// ---------- admin ----------

/** Admin decision panel on a paused or disputed task. Uses the admin API. */
function adminResolvePanel(task) {
  if (!["paused_safety", "disputed"].includes(task.status)) return el("div");
  const outcome = el(
    "select",
    { name: "outcome" },
    el("option", { value: "completed" }, "Completed (pay full rate)"),
    el("option", { value: "partially_completed" }, "Partially completed"),
    el("option", { value: "cancelled" }, "Cancelled"),
    el("option", { value: "in_progress" }, "Resume work"),
  );
  const earned = el("input", { type: "number", min: "0", step: "0.01", placeholder: "Earned per helper ($)" });
  const note = el("input", { maxlength: "500", placeholder: "Note for the record" });
  return el(
    "div",
    { class: "card" },
    el("h4", {}, "Admin decision"),
    el("label", {}, "Outcome", outcome),
    el("label", {}, "Amount per helper (partial or cancelled)", earned),
    el("label", {}, "Note", note),
    el(
      "div",
      { class: "actions" },
      actionButton("Resolve", async () => {
        const body = { outcome: outcome.value, note: note.value };
        if (outcome.value === "partially_completed" || outcome.value === "cancelled") {
          body.earned_cents = toCents(earned.value || 0);
        }
        const res = await run(() => api(`/api/admin/tasks/${task.id}/resolve`, { body }), "Task resolved.");
        if (res) openDetail(task.id);
      }),
    ),
  );
}

function adminRow(parts, buttons) {
  return el("div", { class: "card" }, ...parts, el("div", { class: "actions" }, buttons));
}

async function loadAdmin() {
  const data = await run(() => api("/api/admin/queue"));
  if (!data) return;

  const safety = $("#admin-safety");
  safety.replaceChildren();
  if (!data.safety_reports.length) safety.append(el("p", { class: "hint" }, "No open safety reports."));
  for (const r of data.safety_reports) {
    safety.append(
      adminRow(
        [
          el("strong", {}, r.title),
          el("div", { class: "meta" }, `Task: ${r.task_status.replaceAll("_", " ")}${r.stopped_task ? " · work was stopped" : ""}`),
          el("div", {}, r.description),
        ],
        [
          actionButton("Open task", () => openDetail(r.task_id), "secondary"),
          actionButton("Mark reviewed", async () => {
            const res = await run(() => api(`/api/admin/safety-reports/${r.id}/review`, { body: {} }), "Marked reviewed.");
            if (res) loadAdmin();
          }),
        ],
      ),
    );
  }

  const tasksBox = $("#admin-tasks");
  tasksBox.replaceChildren();
  if (!data.tasks.length) tasksBox.append(el("p", { class: "hint" }, "Nothing waiting for a decision."));
  for (const t of data.tasks) {
    tasksBox.append(
      adminRow(
        [
          el("strong", {}, t.title),
          el("div", { class: "meta" }, `${t.status.replaceAll("_", " ")} · requested by ${t.requester_name} · ${money(t.price_cents)} per helper`),
        ],
        [actionButton("Decide", () => openDetail(t.id))],
      ),
    );
  }

  const verifiedBox = $("#admin-verified");
  verifiedBox.replaceChildren();
  if (!data.verified_members.length) verifiedBox.append(el("p", { class: "hint" }, "No verified members yet."));
  for (const u of data.verified_members) {
    verifiedBox.append(
      adminRow(
        [
          el("strong", {}, u.display_name),
          el("div", { class: "meta" }, `${u.email} · ${u.role_mode.replaceAll("_", " ")} · ${u.city || ""} ${u.zip || ""}`),
        ],
        [actionButton("Revoke", async () => {
          const res = await run(() => api(`/api/admin/users/${u.id}/verification`, { body: { status: "unverified" } }), "Verification removed.");
          if (res) loadAdmin();
        }, "danger")],
      ),
    );
  }

  const unverifiedBox = $("#admin-unverified");
  unverifiedBox.replaceChildren();
  if (!data.unverified_members.length) unverifiedBox.append(el("p", { class: "hint" }, "Everyone is verified or pending review."));
  for (const u of data.unverified_members) {
    unverifiedBox.append(
      adminRow(
        [
          el("strong", {}, u.display_name),
          el("div", { class: "meta" }, `${u.email} · ${u.verification_status} · ${u.role_mode.replaceAll("_", " ")} · ${u.city || ""} ${u.zip || ""}`),
        ],
        [actionButton("Verify", async () => {
          const res = await run(() => api(`/api/admin/users/${u.id}/verification`, { body: { status: "verified" } }), "Verified.");
          if (res) loadAdmin();
        })],
      ),
    );
  }

  const verify = $("#admin-verify");
  verify.replaceChildren();
  if (!data.verification_requests.length) verify.append(el("p", { class: "hint" }, "No verification requests."));
  for (const u of data.verification_requests) {
    const setStatus = (status) => async () => {
      const res = await run(
        () => api(`/api/admin/users/${u.id}/verification`, { body: { status } }),
        status === "verified" ? "Verified." : "Rejected.",
      );
      if (res) loadAdmin();
    };
    verify.append(
      adminRow(
        [
          el("strong", {}, u.display_name),
          el("div", { class: "meta" }, `${u.email} · ${u.role_mode.replaceAll("_", " ")} · ${u.city || ""} ${u.zip || ""}`),
        ],
        [actionButton("Verify", setStatus("verified")), actionButton("Reject", setStatus("rejected"), "danger")],
      ),
    );
  }
}

// ---------- payments ----------

async function startPayment(taskId) {
  const res = await run(() => api(`/api/tasks/${taskId}/funding`, { body: {} }));
  if (res && res.url) window.location.href = res.url;
}

/** Handles the return from Stripe Checkout and the payout setup page. */
async function handleReturns() {
  const params = new URLSearchParams(window.location.search);
  const taskId = params.get("funded_task");
  const sessionId = params.get("session_id");
  if (taskId && sessionId) {
    await run(
      () => api(`/api/tasks/${taskId}/funding/confirm`, { body: { session_id: sessionId } }),
      "Payment received. Your task is now open to helpers.",
    );
    history.replaceState({}, "", "/");
    openDetail(taskId);
  } else if (params.get("funding_cancelled")) {
    notify("Payment was cancelled. The task is not open to helpers yet.", "error");
    history.replaceState({}, "", "/");
  } else if (params.get("payouts")) {
    notify("Payout setup saved. Your status is shown on your profile.", "ok");
    history.replaceState({}, "", "/");
  }
}

async function loadPayouts() {
  const status = $("#payout-status");
  try {
    const data = await api("/api/me/payout-account");
    status.textContent = data.ready
      ? "Payouts are set up. You can accept paid tasks."
      : "Set up payouts before you accept paid tasks. Stripe asks for your bank details and identity, not this app.";
  } catch (err) {
    status.textContent = err.message;
  }
}

$("#payout-setup").addEventListener("click", async () => {
  const res = await run(() => api("/api/me/payout-account", { body: {} }));
  if (res && res.url) window.location.href = res.url;
});

// ---------- community directory ----------

async function loadMembers() {
  const data = await run(() => api("/api/members"));
  const list = $("#members-list");
  list.replaceChildren();
  $("#member-detail").hidden = true;
  if (!data) return;
  if (data.members.length === 0) list.append(el("p", { class: "hint" }, "No members have shared their profile yet."));
  for (const m of data.members) {
    list.append(
      el(
        "article",
        { class: "card" },
        el("h3", {}, m.display_name, m.verified ? el("span", { class: "pill" }, "Verified") : null, m.founder_title ? el("span", { class: "pill" }, m.founder_title) : null),
        el("div", { class: "meta" }, `${m.role_mode.replaceAll("_", " ")}${m.city ? ` · ${m.city}` : ""}${m.state ? `, ${m.state}` : ""}`),
        el("div", {}, ...(m.skills || []).slice(0, 6).map((k) => el("span", { class: "pill" }, k))),
        el("div", { class: "actions" }, actionButton("View profile", () => showMember(m.id), "secondary")),
      ),
    );
  }
}

// ---------- messages ----------

const chat = { id: null, memberId: null, name: "" };

async function loadConversations() {
  const data = await run(() => api("/api/chat/conversations"));
  const list = $("#conv-list");
  list.replaceChildren();
  $("#conv-view").hidden = true;
  if (!data) return;
  if (data.conversations.length === 0) list.append(el("p", { class: "hint" }, "No conversations yet. Open a member's profile in the Community section to start one."));
  for (const c of data.conversations) {
    list.append(
      adminRow([el("strong", {}, c.display_name)], [actionButton("Open", () => openConversation(c.id, c.member_id, c.display_name), "secondary")]),
    );
  }
}

async function openConversation(id, memberId, name) {
  chat.id = id;
  chat.memberId = memberId;
  chat.name = name;
  const data = await run(() => api(`/api/chat/conversations/${id}/messages`));
  if (!data) return;
  $("#conv-title").textContent = name;
  const box = $("#conv-messages");
  box.replaceChildren();
  if (data.messages.length === 0) box.append(el("p", { class: "hint" }, "Say hello."));
  for (const m of data.messages) {
    const parts = [el("div", { class: "meta" }, m.mine ? "You" : name), el("div", {}, m.body)];
    if (m.translated) {
      parts.push(el("details", {}, el("summary", { class: "meta" }, "Translated. Show original"), el("div", { class: "meta" }, m.original)));
    }
    if (!m.mine) parts.push(actionButton("Report", () => reportMessage(m.id), "secondary"));
    box.append(el("article", { class: "card" }, ...parts));
  }
  $$(".view").forEach((v) => (v.hidden = v.id !== "messages"));
  $("#conv-view").hidden = false;
  box.lastElementChild?.scrollIntoView({ block: "end" });
}

async function startConversation(memberId, name) {
  const res = await run(() => api("/api/chat/conversations", { body: { member_id: memberId } }));
  if (res) openConversation(res.id, memberId, name);
}

async function reportMessage(messageId) {
  const reason = window.prompt("What is wrong with this message? (reported to the admin team)");
  if (!reason || reason.trim().length < 3) return;
  await run(() => api(`/api/chat/messages/${messageId}/report`, { body: { reason: reason.trim() } }), "Report sent. Thank you.");
}

$("#msg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = new FormData(e.target).get("body");
  const sent = await run(() => api(`/api/chat/conversations/${chat.id}/messages`, { body: { body: String(body).trim() } }));
  if (sent) {
    e.target.reset();
    openConversation(chat.id, chat.memberId, chat.name);
  }
});

$("#conv-back").addEventListener("click", () => loadConversations());

$("#conv-block").addEventListener("click", async () => {
  if (!window.confirm(`Block ${chat.name}? You won't be able to message each other.`)) return;
  const res = await run(() => api("/api/chat/blocks", { body: { member_id: chat.memberId } }), "Blocked.");
  if (res) loadConversations();
});

async function showMember(id) {
  const data = await run(() => api(`/api/members/${id}`));
  if (!data) return;
  const m = data.member;
  const panel = $("#member-detail");
  panel.hidden = false;
  const canMessage = state.me && state.me.verification_status === "verified" && m.id !== state.me.id;
  panel.replaceChildren(
    el("button", { type: "button", class: "secondary", onclick: () => { panel.hidden = true; loadMembers(); } }, "← Back to directory"),
    canMessage ? el("button", { type: "button", onclick: () => startConversation(m.id, m.display_name) }, "Message") : null,
    el("h3", {}, m.display_name, m.verified ? el("span", { class: "pill" }, "Verified") : null),
    el("div", { class: "meta" }, `${m.role_mode.replaceAll("_", " ")}${m.city ? ` · ${m.city}` : ""}${m.state ? `, ${m.state}` : ""}`),
    m.bio ? el("p", {}, m.bio) : null,
    m.skills?.length ? el("div", {}, el("strong", {}, "Skills: "), m.skills.join(", ")) : null,
    m.tools?.length ? el("div", {}, el("strong", {}, "Tools: "), m.tools.join(", ")) : null,
  );
  $$(".view").forEach((v) => (v.hidden = v.id !== "members"));
  panel.scrollIntoView({ block: "start" });
}

boot();

// Service worker: lets the app install to the home screen and open offline.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Installing is optional; the app still works in the browser without it.
  });
}
