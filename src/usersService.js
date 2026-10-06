// =============================================================================
// USERS SERVICE — admin-driven account provisioning (v3-215, v3-218)
// -----------------------------------------------------------------------------
// Lets a signed-in Super Admin (user_roles.role = 'admin') list the accounts
// that exist, create new ones, edit role / name / mobile, and archive or
// restore accounts from the calculator, instead of someone with the
// service-role key running scripts/seed-*.mjs, set-user-role.mjs or
// deactivate-user.mjs by hand.
//
// WHY THIS LIVES SERVER-SIDE
//   • supabase.auth.admin.* only works with the service-role key, which must
//     never reach the browser (ARCHITECTURE.md §9).
//   • Production's public.user_roles has no INSERT policy and no admin-wide
//     SELECT policy (only "read own row" + an admin/engineering UPDATE), so a
//     browser client could neither list roles nor assign one.
//
// WHAT "CREATE" WRITES — the same three places scripts/set-user-role.mjs and
// scripts/seed-sales-reps.mjs write, so an account made here is
// indistinguishable from a seeded one:
//   1. auth.users via auth.admin.createUser — email confirmed, so the person
//      can sign in immediately; password OR none (Google sign-in only).
//   2. app_metadata.role (+ user_metadata.role / display_name / mobile) — this
//      is what the frontend's fetchUserRole reads FIRST, and app_metadata is
//      service-role-only so the user cannot promote themselves.
//   3. public.user_roles — what THIS backend's resolveEditRole reads to decide
//      who may write parameters. 'rep' is stored as 'view' here because the
//      production CHECK constraint (user_roles_role_check) has no 'rep'.
//   Step 3 failing after step 1 succeeded would leave a half-account, so the
//   just-created user is deleted again and the caller gets a 500.
//
// WHAT "UPDATE" WRITES (v3-218) — the same three places, in set-user-role.mjs's
// order: metadata first (app_metadata.role, user_metadata.role/display_name/
// mobile via auth.admin.updateUserById, which MERGES top-level keys and
// deletes a key sent as null), then public.user_roles. If the table write
// fails the metadata is put back, so the role the frontend shows and the role
// this backend enforces never disagree. A role change reaches the person at
// their next token refresh or sign-in (fetchUserRole reads the session's
// app_metadata), i.e. within the hour.
//
// WHAT "ARCHIVE" DOES (v3-218) — exactly scripts/deactivate-user.mjs: sets
// ban_duration to ~100 years. GoTrue then refuses sign-in, token refresh and
// every authenticated API call (error code user_banned), so archived people
// are locked out of this backend at once and out of the app within the hour
// (their current JWT's lifetime). Nothing is deleted: role, metadata and
// user_roles row stay, so "restore" (ban_duration 'none') brings the account
// back exactly as it was. The list marks a banned account `disabled: true`.
//
// SELF-PROTECTION — an admin may not archive themselves or demote their own
// role: they would lock themselves out of the page they are using. Because
// the actor is always an ACTIVE admin (requireSuperAdmin), this also
// guarantees at least one active Super Admin survives any request.
//
// AUTHORISATION: resolveEditRole's 'edit' (Super Admin) only, the same bar as
// audit history. Its "user_roles table missing → everyone is edit" fallback is
// explicitly REFUSED here — acceptable for reading parameters in a half-built
// environment, not for minting accounts.
// =============================================================================

import { randomBytes } from "node:crypto";
import { getSupabaseClient, resolveEditRole } from "./parametersService.js";

// Everything an admin may assign. Deliberately excludes 'customer': nobody is
// provisioned as a customer — that is fetchUserRole's default for an account
// with no role, and it opens nothing an unauthenticated visitor cannot see.
export const ASSIGNABLE_ROLES = Object.freeze([
  "admin",
  "engineering",
  "product",
  "inventory",
  "finco",
  "view",
  "rep",
]);

// public.user_roles.role CHECK constraint has no 'rep' (see header).
const TABLE_ROLE = (role) => (role === "rep" ? "view" : role);

// Keep in step with SSO_ALLOWED_DOMAINS in the frontend's supabaseClient.js
// and the `allowed` array in 20260918_sso_google_domain_guard.sql. A
// passwordless account outside these domains could never sign in.
const SSO_ALLOWED_DOMAINS = Object.freeze(["solvivaenergy.com"]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// auth.users.id — any UUID version; a cheap 400 instead of a GoTrue round trip.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_PASSWORD_LENGTH = 8; // matches ChangePasswordDialog / ResetPassword
const MAX_PASSWORD_LENGTH = 72;
const MAX_NAME_LENGTH = 120;
const LIST_PAGE_SIZE = 200;
const LIST_MAX_PAGES = 50;
// Effectively permanent (~100 years) — the value scripts/deactivate-user.mjs
// uses, so an account archived here and one deactivated by the script look
// identical. Reversed with ban_duration 'none'.
const ARCHIVE_BAN_DURATION = "876000h";

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Same allowlist the CRM lookup uses (crmContactService.normalisePhPhone):
// stores 09XXXXXXXXX, the shape seed-sales-reps.mjs writes and the calculator's
// agent-mobile field expects. Returns null for anything it will not vouch for.
export function normaliseMobile(raw) {
  if (!raw || typeof raw !== "string") return null;
  let d = raw.replace(/\D+/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 12 && d.startsWith("63")) return `0${d.slice(2)}`;
  if (d.length === 11 && d.startsWith("09")) return d;
  if (d.length === 10 && d.startsWith("9")) return `0${d}`;
  return null;
}

// 16 chars from a 55-symbol alphabet (~92 bits) — the same strength class as
// seed-sales-reps.mjs's random passwords. I/O/i/l/o/0/1 are left out because
// these get read aloud or retyped from a chat message. Rejection sampling
// keeps the draw uniform (256 % 55 != 0).
export function generatePassword(length = 16) {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const out = [];
  while (out.length < length) {
    const bytes = randomBytes(length);
    for (const b of bytes) {
      if (out.length >= length) break;
      if (b < alphabet.length * Math.floor(256 / alphabet.length)) {
        out.push(alphabet[b % alphabet.length]);
      }
    }
  }
  return out.join("");
}

// The role the FRONTEND will resolve for this user — fetchUserRole's order of
// precedence: app_metadata.role, then user_metadata.role, then user_roles,
// then 'customer'. Shown in the list so an admin sees what the user sees.
function effectiveRole(user, tableRole) {
  const meta = user.app_metadata?.role || user.user_metadata?.role;
  if (meta) return meta;
  return tableRole || "customer";
}

function isBanned(user) {
  if (!user.banned_until) return false;
  const until = Date.parse(user.banned_until);
  return Number.isFinite(until) && until > Date.now();
}

function toPublicUser(user, tableRole) {
  return {
    id: user.id,
    email: user.email || null,
    displayName: user.user_metadata?.display_name || null,
    mobile: user.user_metadata?.mobile || null,
    role: effectiveRole(user, tableRole),
    tableRole: tableRole || null,
    providers: Array.isArray(user.app_metadata?.providers)
      ? user.app_metadata.providers
      : user.app_metadata?.provider
        ? [user.app_metadata.provider]
        : [],
    createdAt: user.created_at || null,
    lastSignInAt: user.last_sign_in_at || null,
    disabled: isBanned(user),
  };
}

// Super Admin gate shared by every entry point. Returns { actor } or
// { status, error } in resolveEditRole's shape.
async function requireSuperAdmin(supabase, accessToken) {
  const auth = await resolveEditRole(supabase, accessToken);
  if (auth.error) return { status: auth.status, error: auth.error };
  if (auth.fallback) {
    return {
      status: 503,
      error: "User management is unavailable until public.user_roles exists.",
    };
  }
  if (auth.role !== "edit") {
    return {
      status: 403,
      error: "User management is restricted to administrators.",
    };
  }
  return { actor: { userId: auth.userId, email: auth.email || null } };
}

async function listAllAuthUsers(supabase) {
  const users = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: LIST_PAGE_SIZE,
    });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    users.push(...(data?.users || []));
    if ((data?.users || []).length < LIST_PAGE_SIZE) break;
  }
  return users;
}

// ─── Public entry points ─────────────────────────────────────────────────────

export async function listUsers(accessToken) {
  const supabase = getSupabaseClient();
  const gate = await requireSuperAdmin(supabase, accessToken);
  if (gate.error) return { status: gate.status, payload: { error: gate.error } };

  const [authUsers, rolesResult] = await Promise.all([
    listAllAuthUsers(supabase),
    supabase.from("user_roles").select("user_id, role"),
  ]);
  if (rolesResult.error) {
    throw new Error(`user_roles query failed: ${rolesResult.error.message}`);
  }
  const tableRoles = new Map(
    (rolesResult.data || []).map((row) => [row.user_id, row.role]),
  );

  const users = authUsers
    .map((u) => toPublicUser(u, tableRoles.get(u.id)))
    .sort((a, b) => String(a.email || "").localeCompare(String(b.email || "")));

  // actorId lets the Users tab mark the caller's own row and hide the actions
  // the backend would refuse anyway (archive self, demote self).
  return { status: 200, payload: { users, actorId: gate.actor.userId } };
}

// Validates a create request body. Returns { value } or { error }.
// Exported so the shape can be unit-checked without a Supabase client.
export function validateCreateUserInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object." };
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return { error: "Enter a valid email address." };
  }

  const role = String(body.role ?? "").trim();
  if (!ASSIGNABLE_ROLES.includes(role)) {
    return { error: `Role must be one of: ${ASSIGNABLE_ROLES.join(", ")}.` };
  }

  const displayNameRaw = body.displayName == null ? "" : String(body.displayName);
  const displayName = displayNameRaw.trim().replace(/\s+/g, " ");
  if (displayName.length > MAX_NAME_LENGTH) {
    return { error: `Display name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }

  let mobile = null;
  const mobileRaw = body.mobile == null ? "" : String(body.mobile).trim();
  if (mobileRaw) {
    mobile = normaliseMobile(mobileRaw);
    if (!mobile) {
      return { error: "Enter a valid Philippine mobile number (11 digits starting with 09)." };
    }
  }

  const ssoOnly = body.ssoOnly === true;
  let password = null;
  if (ssoOnly) {
    const domain = email.split("@")[1] || "";
    if (!SSO_ALLOWED_DOMAINS.includes(domain)) {
      return {
        error:
          `A Google-only account must use a ${SSO_ALLOWED_DOMAINS.map((d) => `@${d}`).join(" or ")} ` +
          "address — anything else could never sign in. Set a password instead.",
      };
    }
  } else {
    password = body.password == null ? "" : String(body.password);
    if (password.length < MIN_PASSWORD_LENGTH) {
      return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      return { error: `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.` };
    }
  }

  return {
    value: { email, role, displayName: displayName || null, mobile, ssoOnly, password },
  };
}

// GoTrue's own wording for an email that already exists changed across
// versions ("already been registered", "already exists") and the error carries
// a code on newer SDKs. Match all three so the caller gets a 409, not a 500.
function isDuplicateEmailError(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || "").toLowerCase();
  return (
    code === "email_exists" ||
    (error?.status === 422 && msg.includes("already")) ||
    msg.includes("already been registered") ||
    msg.includes("already exists")
  );
}

export async function createUser(body, accessToken, requestId) {
  const supabase = getSupabaseClient();
  const gate = await requireSuperAdmin(supabase, accessToken);
  if (gate.error) return { status: gate.status, payload: { error: gate.error } };

  const parsed = validateCreateUserInput(body);
  if (parsed.error) return { status: 400, payload: { error: parsed.error } };
  const { email, role, displayName, mobile, ssoOnly, password } = parsed.value;

  // 1 + 2. auth.users row with the role in BOTH metadata blocks (see header).
  const userMetadata = { role };
  if (displayName) userMetadata.display_name = displayName;
  if (mobile) userMetadata.mobile = mobile;
  const createAttrs = {
    email,
    email_confirm: true,
    app_metadata: { role },
    user_metadata: userMetadata,
  };
  if (!ssoOnly) createAttrs.password = password;

  const { data: created, error: createError } =
    await supabase.auth.admin.createUser(createAttrs);
  if (createError) {
    if (isDuplicateEmailError(createError)) {
      return {
        status: 409,
        payload: { error: "An account with that email already exists." },
      };
    }
    // GoTrue's message is safe to surface (weak password, invalid email);
    // the frontend shows it inline.
    return {
      status: 502,
      payload: { error: `Could not create the account: ${createError.message}` },
    };
  }
  const user = created.user;

  // 3. public.user_roles — what resolveEditRole reads.
  const { error: roleError } = await supabase.from("user_roles").upsert(
    { user_id: user.id, role: TABLE_ROLE(role), updated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  if (roleError) {
    // Roll back so a retry is not met with a 409 for a half-made account.
    const { error: cleanupError } = await supabase.auth.admin.deleteUser(user.id);
    console.error("[users] role assignment failed; user rolled back", {
      requestId,
      actor: gate.actor.userId,
      email,
      role,
      reason: roleError.message,
      cleanup: cleanupError ? `FAILED: ${cleanupError.message}` : "ok",
    });
    return {
      status: 500,
      payload: {
        error: cleanupError
          ? "The account was created but its role could not be saved, and the rollback failed. Ask an engineer to check user_roles."
          : "The role could not be saved, so the account was not created. Try again.",
      },
    };
  }

  // No audit table for accounts yet (parameter_audit_events is parameter-
  // shaped, with NOT NULL before/after payloads); the actor and target are
  // logged so Render's log stream carries a record of who created whom.
  console.log("[users] created", {
    requestId,
    actorUserId: gate.actor.userId,
    actorEmail: gate.actor.email,
    userId: user.id,
    email,
    role,
    tableRole: TABLE_ROLE(role),
    signIn: ssoOnly ? "google-only" : "password",
  });

  return {
    status: 201,
    payload: { user: toPublicUser(user, TABLE_ROLE(role)) },
  };
}

// ─── Update / archive (v3-218) ───────────────────────────────────────────────

// Validates a PATCH body. A key that is ABSENT leaves that field alone; a key
// present as null or "" clears it (display name, mobile). Returns { value } with
// only the fields to change, or { error }. Exported for unit checks.
export function validateUpdateUserInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object." };
  }
  const value = {};

  if ("role" in body) {
    const role = String(body.role ?? "").trim();
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return { error: `Role must be one of: ${ASSIGNABLE_ROLES.join(", ")}.` };
    }
    value.role = role;
  }

  if ("displayName" in body) {
    const raw = body.displayName == null ? "" : String(body.displayName);
    const displayName = raw.trim().replace(/\s+/g, " ");
    if (displayName.length > MAX_NAME_LENGTH) {
      return { error: `Display name must be ${MAX_NAME_LENGTH} characters or fewer.` };
    }
    value.displayName = displayName || null;
  }

  if ("mobile" in body) {
    const raw = body.mobile == null ? "" : String(body.mobile).trim();
    if (raw) {
      const mobile = normaliseMobile(raw);
      if (!mobile) {
        return { error: "Enter a valid Philippine mobile number (11 digits starting with 09)." };
      }
      value.mobile = mobile;
    } else {
      value.mobile = null;
    }
  }

  if (Object.keys(value).length === 0) {
    return { error: "Nothing to update — send a role, displayName or mobile." };
  }
  return { value };
}

function isNotFoundError(error) {
  return (
    error?.status === 404 ||
    String(error?.code || "") === "user_not_found" ||
    String(error?.message || "").toLowerCase().includes("not found")
  );
}

// Loads the target account, or answers 400/404 in the route's shape.
async function loadTarget(supabase, userId) {
  if (!UUID_RE.test(String(userId || ""))) {
    return { status: 400, error: "Invalid user id." };
  }
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error) {
    if (isNotFoundError(error)) return { status: 404, error: "User not found." };
    return { status: 502, error: `Could not load the account: ${error.message}` };
  }
  if (!data?.user) return { status: 404, error: "User not found." };
  return { user: data.user };
}

async function readTableRole(supabase, userId) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`user_roles query failed: ${error.message}`);
  return data?.role || null;
}

// The metadata object that undoes `next` on top of `prev` under GoTrue's
// merge semantics: keys we added are sent as null (delete), the rest go back
// to their previous values.
function revertMetadata(prev, next) {
  const out = { ...prev };
  for (const key of Object.keys(next)) {
    if (!(key in prev)) out[key] = null;
  }
  return out;
}

export async function updateUser(userId, body, accessToken, requestId) {
  const supabase = getSupabaseClient();
  const gate = await requireSuperAdmin(supabase, accessToken);
  if (gate.error) return { status: gate.status, payload: { error: gate.error } };

  const parsed = validateUpdateUserInput(body);
  if (parsed.error) return { status: 400, payload: { error: parsed.error } };
  const patch = parsed.value;

  const target = await loadTarget(supabase, userId);
  if (target.error) return { status: target.status, payload: { error: target.error } };
  const { user } = target;

  const isSelf = user.id === gate.actor.userId;
  if (isSelf && patch.role !== undefined && patch.role !== "admin") {
    return {
      status: 400,
      payload: { error: "You cannot change your own role. Ask another Super Admin to do it." },
    };
  }

  const prevAppMeta = user.app_metadata || {};
  const prevUserMeta = user.user_metadata || {};
  const roleChanged = patch.role !== undefined;

  // 1 + 2. Metadata (merged by GoTrue; null deletes the key).
  const appMeta = { ...prevAppMeta };
  const userMeta = { ...prevUserMeta };
  if (roleChanged) {
    appMeta.role = patch.role;
    userMeta.role = patch.role;
  }
  if (patch.displayName !== undefined) userMeta.display_name = patch.displayName;
  if (patch.mobile !== undefined) userMeta.mobile = patch.mobile;

  const { data: updated, error: metaError } = await supabase.auth.admin.updateUserById(
    user.id,
    { app_metadata: appMeta, user_metadata: userMeta },
  );
  if (metaError) {
    return {
      status: 502,
      payload: { error: `Could not update the account: ${metaError.message}` },
    };
  }

  // 3. public.user_roles — what resolveEditRole reads. Only touched when the
  // role changes; name/mobile live in metadata alone.
  let tableRole;
  if (roleChanged) {
    tableRole = TABLE_ROLE(patch.role);
    const { error: roleError } = await supabase.from("user_roles").upsert(
      { user_id: user.id, role: tableRole, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (roleError) {
      const { error: revertError } = await supabase.auth.admin.updateUserById(user.id, {
        app_metadata: revertMetadata(prevAppMeta, appMeta),
        user_metadata: revertMetadata(prevUserMeta, userMeta),
      });
      console.error("[users] role update failed; metadata reverted", {
        requestId,
        actor: gate.actor.userId,
        userId: user.id,
        role: patch.role,
        reason: roleError.message,
        revert: revertError ? `FAILED: ${revertError.message}` : "ok",
      });
      return {
        status: 500,
        payload: {
          error: revertError
            ? "The role could not be saved and the account's metadata could not be put back. Ask an engineer to check user_roles."
            : "The role could not be saved, so nothing was changed. Try again.",
        },
      };
    }
  } else {
    tableRole = await readTableRole(supabase, user.id);
  }

  console.log("[users] updated", {
    requestId,
    actorUserId: gate.actor.userId,
    actorEmail: gate.actor.email,
    userId: user.id,
    email: user.email || null,
    changed: Object.keys(patch),
    role: roleChanged ? patch.role : undefined,
  });

  return {
    status: 200,
    payload: { user: toPublicUser(updated?.user || user, tableRole) },
  };
}

// archived: true → ban (archive); false → lift the ban (restore).
export async function setUserArchived(userId, archived, accessToken, requestId) {
  const supabase = getSupabaseClient();
  const gate = await requireSuperAdmin(supabase, accessToken);
  if (gate.error) return { status: gate.status, payload: { error: gate.error } };

  const target = await loadTarget(supabase, userId);
  if (target.error) return { status: target.status, payload: { error: target.error } };
  const { user } = target;

  if (archived && user.id === gate.actor.userId) {
    return {
      status: 400,
      payload: { error: "You cannot archive your own account. Ask another Super Admin to do it." },
    };
  }

  const { data: updated, error } = await supabase.auth.admin.updateUserById(user.id, {
    ban_duration: archived ? ARCHIVE_BAN_DURATION : "none",
  });
  if (error) {
    return {
      status: 502,
      payload: {
        error: `Could not ${archived ? "archive" : "restore"} the account: ${error.message}`,
      },
    };
  }

  console.log(`[users] ${archived ? "archived" : "restored"}`, {
    requestId,
    actorUserId: gate.actor.userId,
    actorEmail: gate.actor.email,
    userId: user.id,
    email: user.email || null,
  });

  const tableRole = await readTableRole(supabase, user.id);
  return {
    status: 200,
    payload: { user: toPublicUser(updated?.user || user, tableRole) },
  };
}
