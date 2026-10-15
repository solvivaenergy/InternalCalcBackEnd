// =============================================================================
// HTTP AUTH for the MCP server — shared service token + Anthropic IP allowlist
// -----------------------------------------------------------------------------
// A port of monitoring/mcp_auth.py (the gate in front of the "Solviva Systems"
// and "Solviva Databases" connectors), kept behaviour-identical so the three
// connectors are configured the same way in claude.ai: a fixed bearer token
// sent as a request header, plus an allowlist of Anthropic's egress range so a
// leaked token is useless from anywhere else.
//
// No OAuth on purpose, and deliberately NO WWW-Authenticate header on a 401:
// that would tell Claude this is an OAuth resource server and send it looking
// for discovery documents we do not serve.
// =============================================================================

import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

// Anthropic's published egress range. Every request Claude makes to a
// connector comes from here, so anything else is not Claude.
export const ANTHROPIC_EGRESS = "160.79.104.0/21";

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr4(ip, cidr) {
  const [net, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(net) & mask);
}

// Unwrap an IPv4-mapped IPv6 address ("::ffff:1.2.3.4") to its IPv4 form.
function normalizeIp(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : s;
}

function isPublicIp(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    const inRange = (cidr) => inCidr4(ip, cidr);
    return !(
      inRange("0.0.0.0/8") ||
      inRange("10.0.0.0/8") ||
      inRange("100.64.0.0/10") ||
      inRange("127.0.0.0/8") ||
      inRange("169.254.0.0/16") ||
      inRange("172.16.0.0/12") ||
      inRange("192.168.0.0/16") ||
      inRange("224.0.0.0/3") ||
      n === 0xffffffff
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    return !(
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    );
  }
  return false;
}

// The caller's real public IP as seen through Render's proxy chain. Render
// fronts every service with Cloudflare, which sets CF-Connecting-IP to the
// true client address and overwrites whatever the client sent, so that header
// is authoritative and is checked first. The X-Forwarded-For fallback walks
// from the right and takes the first PUBLIC address (leading entries are
// client-supplied, trailing entries are internal hops).
export function clientIp(req) {
  for (const header of ["cf-connecting-ip", "true-client-ip"]) {
    const raw = normalizeIp(req.headers[header]);
    if (raw && isIP(raw)) return raw;
  }
  const chain = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((p) => normalizeIp(p))
    .filter(Boolean);
  if (chain.length === 0) chain.push(normalizeIp(req.socket?.remoteAddress));
  for (const addr of chain.reverse()) {
    if (isIP(addr) && isPublicIp(addr)) return addr;
  }
  return null;
}

export function fromAnthropic(req) {
  const ip = clientIp(req);
  return !!ip && isIP(ip) === 4 && inCidr4(ip, ANTHROPIC_EGRESS);
}

// Express middleware. `token` is the shared secret; `restrictIps` false skips
// the egress allowlist (local testing only). /healthz is answered before the
// gate so Render's health check needs no credential.
export function bearerAuth({ token, restrictIps = true }) {
  const expected = Buffer.from(`Bearer ${token}`);
  return (req, res, next) => {
    if (req.path === "/healthz") {
      return res.status(200).json({ status: "ok" });
    }
    if (restrictIps && !fromAnthropic(req)) {
      // Log the chain: getting the proxy-hop depth wrong here silently rejects
      // every legitimate request, and the header is the only way to see what
      // the platform actually forwarded.
      console.log(
        `[auth] rejected ${req.path} — resolved client ${clientIp(req)} not in ${ANTHROPIC_EGRESS}; ` +
          `x-forwarded-for=${JSON.stringify(req.headers["x-forwarded-for"] || "(none)")}`,
      );
      return res.status(403).json({ error: "forbidden" });
    }
    const supplied = String(req.headers.authorization || "");
    const given = Buffer.from(supplied);
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      // Distinguish "no credential" from "wrong credential": the fixes are
      // different and from outside both look like the same 401. Never log the
      // token itself.
      let detail;
      if (!supplied) detail = "no Authorization header sent";
      else if (!supplied.startsWith("Bearer ")) detail = `Authorization header missing 'Bearer ' prefix (starts ${JSON.stringify(supplied.slice(0, 8))})`;
      else detail = `token mismatch: got ${supplied.length - 7} chars, expected ${expected.length - 7}`;
      console.log(`[auth] 401 on ${req.path} — ${detail}`);
      return res.status(401).json({ error: "invalid_token" });
    }
    next();
  };
}

// DNS-rebinding protection: when MCP_PUBLIC_HOST is set, the Host header must
// be that hostname (with or without a port). Mirrors the Python servers'
// TransportSecuritySettings(allowed_hosts=[host, host:*]).
export function hostGuard(publicHost) {
  const host = String(publicHost || "").trim().toLowerCase();
  if (!host) return (_req, _res, next) => next();
  return (req, res, next) => {
    const given = String(req.headers.host || "").toLowerCase();
    if (given === host || given.startsWith(`${host}:`) || req.path === "/healthz") return next();
    console.log(`[auth] 421 on ${req.path} — Host ${JSON.stringify(given)} is not ${host}`);
    return res.status(421).json({ error: "misdirected_request" });
  };
}
