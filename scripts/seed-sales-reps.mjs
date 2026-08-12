// Provisioning for the Sales team rep accounts.
// Uses the Supabase Admin API (service-role key from .env). Each user mirrors
// sales.rep.demo@aboitizpower.com exactly: role 'rep' is stored in BOTH
// user_metadata.role and app_metadata.role (this is what fetchUserRole reads
// first), while public.user_roles.role is set to 'view' — the production CHECK
// constraint (user_roles_role_check) only permits admin/engineering/product/
// view, so 'rep' cannot live in that table. display_name + mobile are stored
// in user_metadata so the calculator can auto-populate the "Solviva Agent
// details" fields on login.
//
//   node scripts/seed-sales-reps.mjs
//
// IDEMPOTENT: a fully-provisioned account (already carrying role 'rep' in both
// metadata blocks) keeps its password (NOT rotated); only metadata + role are
// refreshed. A brand-new OR partially-provisioned account gets a strong random
// password, printed ONCE in the run summary — copy it before closing the
// terminal; it is not stored anywhere.
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Roster ──────────────────────────────────────────────────────────────────
// name → display_name (user_metadata + agent auto-fill)
// mobile → PH mobile (user_metadata.mobile), normalized to 09XXXXXXXXX.
const REPS = [
  {
    name: "Patrick Avedillo",
    email: "patrick.avedillo@solvivaenergy.com",
    mobile: "09171486078",
  },
  {
    name: "Leonard Hutalla",
    email: "leonard@solvivaenergy.com",
    mobile: "09178221374",
  },
  {
    name: "Kristal Atanacio",
    email: "kristal@solvivaenergy.com",
    mobile: "09171244812",
  },
  {
    name: "Arniel Banez",
    email: "arneil.banez@solvivaenergy.com",
    mobile: "09171069841",
  },
  {
    name: "Rowena Garcia",
    email: "rowena@solvivaenergy.com",
    mobile: "09175123674",
  },
  {
    name: "Derrick Elacio",
    email: "derrick@solvivaenergy.com",
    mobile: "09171626772",
  },
  {
    name: "Christine Domingo",
    email: "christine.domingo@solvivaenergy.com",
    mobile: "09171383114",
  },
  {
    name: "Halzina Abella",
    email: "halzina.abella@solvivaenergy.com",
    mobile: "09763424306",
  },
  {
    name: "Marco Castro",
    email: "marco.castro@solvivaenergy.com",
    mobile: "09164350077",
  },
  {
    name: "Jeny Ann Dotarot",
    email: "jeny.dotarot@solvivaenergy.com",
    mobile: "09171648870",
  },
  {
    name: "Samuel Daroya",
    email: "samuel.daroya@solvivaenergy.com",
    mobile: "09764048458",
  },
  {
    name: "Abelyn Seno",
    email: "abelyn.seno@solvivaenergy.com",
    mobile: "09171684038",
  },
  {
    name: "Arianne Kate Olazo",
    email: "arianne.olazo@solvivaenergy.com",
    mobile: "",
  },
  {
    name: "Jane Romyer Ann Castro",
    email: "jane.castro@solvivaenergy.com",
    mobile: "09452719828",
  },
  {
    name: "Katrina Medina",
    email: "katrina.medina@solvivaenergy.com",
    mobile: "09624861880",
  },
  {
    name: "Camille Bueno",
    email: "camille.bueno@solvivaenergy.com",
    mobile: "09763935085",
  },
  {
    name: "Vanessa Joy Apostol",
    email: "vanessa.apostol@solvivaenergy.com",
    mobile: "09466856458",
  },
  {
    name: "Ed Paulo Ramos",
    email: "edpaulo.ramos@solvivaenergy.com",
    mobile: "09756605457",
  },
  {
    name: "Carey Chua",
    email: "carey.chua@solvivaenergy.com",
    mobile: "09171889477",
  },
  {
    name: "Danica Guerrero",
    email: "danica.guerrero@solvivaenergy.com",
    mobile: "09937366291",
  },
  {
    name: "John Paolo Jorvina",
    email: "john.jorvina@solvivaenergy.com",
    mobile: "09933297345",
  },
  {
    name: "Marjorie Oma",
    email: "marjorie.oma@solvivaenergy.com",
    mobile: "09060953071",
  },
  {
    name: "Dreks Fernandez",
    email: "dreks.fernandez@solvivaenergy.com",
    mobile: "09171178911",
  },
  {
    name: "Reggie Pilante",
    email: "reggie.pilante@solvivaenergy.com",
    mobile: "09171430025",
  },
  {
    name: "Jennifer Corpuz",
    email: "jennifer.corpuz@solvivaenergy.com",
    mobile: "09369546839",
  },
  {
    name: "Janno Fransisco",
    email: "janno.francisco@solvivaenergy.com",
    mobile: "09360556692",
  },
  {
    name: "Mark Herero",
    email: "mark.herero@solvivaenergy.com",
    mobile: "09762164096",
  },
  {
    name: "Genyrose Zaspa",
    email: "genyrose.zaspa@solvivaenergy.com",
    mobile: "09171701752",
  },
  {
    name: "George Lufrangco",
    email: "george.lufrangco@solvivaenergy.com",
    mobile: "09171122987",
  },
  {
    name: "Raymond Nicolas",
    email: "raymond.nicolas@solvivaenergy.com",
    mobile: "09171900727",
  },
  {
    name: "Leoniza Anub",
    email: "leoniza@solvivaenergy.com",
    mobile: "09171269479",
  },
  {
    name: "Regine Tiongson",
    email: "regine.tiongson@solvivaenergy.com",
    mobile: "09171506706",
  },
  {
    name: "Eduardo Garrovillas",
    email: "eduardo.garrovillas@solvivaenergy.com",
    mobile: "",
  },
];

// Effective role read by the frontend (fetchUserRole → app_metadata.role ||
// user_metadata.role). Matches sales.rep.demo.
const ROLE = "rep";
// Value written to public.user_roles.role. The production CHECK constraint
// rejects 'rep'/'customer'; 'view' is what sales.rep.demo carries there.
const TABLE_ROLE = "view";

// Strong, human-copyable random password. Excludes ambiguous characters
// (0/O, 1/l/I) and guarantees at least one of each required class.
function generatePassword() {
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digit = "23456789";
  const symbol = "!@#$%^&*";
  const all = upper + lower + digit + symbol;
  const pick = (set) => set[randomBytes(1)[0] % set.length];
  const chars = [pick(upper), pick(lower), pick(digit), pick(symbol)];
  for (let i = chars.length; i < 16; i++) chars.push(pick(all));
  // Fisher-Yates shuffle so the guaranteed classes aren't always leading.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

async function findUserByEmail(email) {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw error;
    const hit = data.users.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase(),
    );
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

async function upsertRep({ name, email, mobile }) {
  const userMeta = { role: ROLE, full_name: name, display_name: name, mobile };
  const appMeta = { role: ROLE };
  let user = await findUserByEmail(email);
  let password = null;
  let status;

  if (!user) {
    password = generatePassword();
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: userMeta,
      app_metadata: appMeta,
    });
    if (error) throw error;
    user = data.user;
    status = "created";
  } else {
    // Fully provisioned = role already set in BOTH metadata blocks. Such an
    // account keeps its working password. A partially-provisioned account
    // (e.g. created by a prior failed run before the role step) gets a fresh
    // password so it becomes usable.
    const fullyProvisioned =
      user.app_metadata?.role === ROLE && user.user_metadata?.role === ROLE;
    const patch = {
      email_confirm: true,
      user_metadata: { ...user.user_metadata, ...userMeta },
      app_metadata: { ...user.app_metadata, ...appMeta },
    };
    if (fullyProvisioned) {
      status = "existing (password unchanged)";
    } else {
      password = generatePassword();
      patch.password = password;
      status = "repaired (password set)";
    }
    const { error } = await supabase.auth.admin.updateUserById(user.id, patch);
    if (error) throw error;
  }

  const { error: roleError } = await supabase.from("user_roles").upsert(
    {
      user_id: user.id,
      role: TABLE_ROLE,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (roleError) throw roleError;

  return { email, name, status, password };
}

(async () => {
  console.log(`Seeding ${REPS.length} rep accounts on ${new URL(url).host}\n`);
  const results = [];
  for (const rep of REPS) {
    try {
      const r = await upsertRep(rep);
      results.push(r);
      console.log(`  ${r.status.padEnd(28)} ${r.email}`);
    } catch (err) {
      results.push({
        email: rep.email,
        name: rep.name,
        status: "FAILED",
        error: err.message || String(err),
      });
      console.error(`  FAILED  ${rep.email}: ${err.message || err}`);
      process.exitCode = 1;
    }
  }

  const withPassword = results.filter((r) => r.password);
  if (withPassword.length) {
    console.log("\n─── ACCOUNT PASSWORDS (copy now — not stored) ───");
    for (const r of withPassword) {
      console.log(`${r.email}\t${r.password}`);
    }
  }

  const failed = results.filter((r) => r.status === "FAILED");
  const unchanged = results.filter(
    (r) => r.status === "existing (password unchanged)",
  );
  console.log(
    `\nDone. ${withPassword.length} provisioned (password shown), ` +
      `${unchanged.length} existing (unchanged), ` +
      `${failed.length} failed.`,
  );
})();
