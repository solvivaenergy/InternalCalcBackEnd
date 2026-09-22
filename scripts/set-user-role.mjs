// Assign (or inspect) one user's role via the Supabase Admin API.
//
//   node scripts/set-user-role.mjs <email> <role>             # dry run: show current state
//   node scripts/set-user-role.mjs <email> <role> --apply     # write it
//   node scripts/set-user-role.mjs <email> <role> --apply --create
//                                   # also create the user (confirmed, no
//                                   # password) if absent — for SSO-only
//                                   # accounts that should have a role
//                                   # waiting before their first Google login
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env (production) or
//      DOTENV_CONFIG_PATH=.env.staging for staging. The target host is
//      printed first — read it before trusting the output.
//
// Writes the two places the frontend's fetchUserRole reads, in its order of
// precedence: app_metadata.role (service-role only, so users cannot edit it)
// and public.user_roles.role. 'rep' is the one role user_roles' CHECK
// constraint does not allow, so reps are stored as 'view' there — the same
// convention as scripts/seed-sales-reps.mjs.
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(1);
}

// Everything fetchUserRole understands, apart from the implicit 'customer'.
const ROLES = ["admin", "engineering", "product", "inventory", "finco", "view", "rep"];
// public.user_roles.role CHECK constraint (user_roles_role_check).
const TABLE_ROLE = (role) => (role === "rep" ? "view" : role);

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [email, role] = args.filter((a) => !a.startsWith("--"));
if (!email || !role || !ROLES.includes(role)) {
  console.error(`usage: node scripts/set-user-role.mjs <email> <${ROLES.join("|")}> [--apply] [--create]`);
  process.exit(1);
}
const APPLY = flags.has("--apply");
const CREATE = flags.has("--create");

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function findUserByEmail(target) {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === target.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

async function describe(user) {
  const { data: row, error } = await supabase
    .from("user_roles")
    .select("role, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  return {
    id: user.id,
    providers: user.app_metadata?.providers ?? [user.app_metadata?.provider ?? "?"],
    "app_metadata.role": user.app_metadata?.role ?? null,
    "user_roles.role": row?.role ?? null,
    last_sign_in: user.last_sign_in_at ?? null,
  };
}

(async () => {
  console.log(`Target Supabase host: ${new URL(url).host}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "dry run (no changes)"}\n`);

  let user = await findUserByEmail(email);
  if (!user) {
    if (!(APPLY && CREATE)) {
      console.error(`User not found: ${email}.` + (APPLY ? " Re-run with --create to add them." : " No changes made."));
      process.exit(APPLY ? 1 : 0);
    }
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true, // no password: sign-in only through a linked provider
    });
    if (error) throw error;
    user = data.user;
    console.log(`created ${email} (${user.id}) — no password, SSO only`);
  }

  console.log("BEFORE", await describe(user));
  if (!APPLY) return;

  const { error: metaError } = await supabase.auth.admin.updateUserById(user.id, {
    app_metadata: { ...(user.app_metadata ?? {}), role },
  });
  if (metaError) throw metaError;

  const { error: roleError } = await supabase
    .from("user_roles")
    .upsert(
      { user_id: user.id, role: TABLE_ROLE(role), updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (roleError) throw roleError;

  const fresh = await findUserByEmail(email);
  console.log("AFTER ", await describe(fresh));
  console.log(`\n${email} -> ${role}. Revert: node scripts/set-user-role.mjs ${email} <previous role> --apply`);
})().catch((err) => {
  console.error("\nFAILED:", err.message || err);
  process.exit(1);
});
