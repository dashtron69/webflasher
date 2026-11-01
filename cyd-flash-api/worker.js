// Cloudflare Worker: Stripe checkout + payment verification + firmware proxy
// Secrets (wrangler secret put): STRIPE_SECRET_KEY, GITHUB_TOKEN (only if firmware repo is private)
// Vars (wrangler.toml): SITE_URL, FIRMWARE_OWNER, FIRMWARE_REPO, FIRMWARE_BRANCH

const BOARDS = ["ILI9341", "ST7789"];

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.SITE_URL, // e.g. https://yourname.github.io  (no trailing slash/path)
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(env) },
  });
}

async function stripe(env, path, method = "GET", body) {
  const res = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + env.STRIPE_SECRET_KEY,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  return res.json();
}

// Fetch a file from the firmware repo (works for public or private repo)
async function fetchFirmware(env, path) {
  const { FIRMWARE_OWNER: o, FIRMWARE_REPO: r, FIRMWARE_BRANCH: b = "main" } = env;
  if (env.GITHUB_TOKEN) {
    return fetch(`https://api.github.com/repos/${o}/${r}/contents/${path}?ref=${b}`, {
      headers: {
        Authorization: "Bearer " + env.GITHUB_TOKEN,
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "flash-worker",
      },
    });
  }
  return fetch(`https://raw.githubusercontent.com/${o}/${r}/${b}/${path}`);
}

async function assertPaid(env, sessionId) {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId || "")) return false;
  const s = await stripe(env, "/checkout/sessions/" + sessionId);
  return s && s.payment_status === "paid";
}

// Collect every object that has an address + path (robust to manifest layout)
function collectParts(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectParts(n, out));
  else if (node && typeof node === "object") {
    if (node.address && node.path) out.push(node);
    else Object.values(node).forEach((n) => collectParts(n, out));
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });

    try {
      // 1) Create Checkout Session (39 THB)
      if (url.pathname === "/checkout" && request.method === "POST") {
        const s = await stripe(env, "/checkout/sessions", "POST", {
          mode: "payment",
          "line_items[0][price_data][currency]": "thb",
          "line_items[0][price_data][unit_amount]": "3900", // satang
          "line_items[0][price_data][product_data][name]": "สนับสนุนค่าน้ำชา - Flash Tool",
          "line_items[0][quantity]": "1",
          "payment_method_types[0]": "card",
          "payment_method_types[1]": "promptpay",
          success_url: env.SITE_URL + (env.SITE_PATH || "/") + "?session_id={CHECKOUT_SESSION_ID}",
          cancel_url: env.SITE_URL + (env.SITE_PATH || "/"),
        });
        if (!s.url) return json(env, { error: s.error?.message || "stripe error" }, 500);
        return json(env, { url: s.url });
      }

      // 2) Verify payment + return list of parts for the chosen board
      if (url.pathname === "/parts") {
        const sid = url.searchParams.get("session_id");
        const board = url.searchParams.get("board");
        if (!BOARDS.includes(board)) return json(env, { error: "bad board" }, 400);
        if (!(await assertPaid(env, sid))) return json(env, { error: "not paid" }, 402);

        const mf = await fetchFirmware(env, "firmware-installer/manifest.json");
        if (!mf.ok) return json(env, { error: "manifest not found" }, 502);
        const parts = collectParts(await mf.json())
          .filter((p) => p.path.includes(`/${board}/`))
          .map((p) => ({ name: p.name, address: p.address, path: p.path, size: p.size, sha256: p.sha256 }));
        if (!parts.length) return json(env, { error: "no parts for board" }, 404);
        return json(env, { parts });
      }

      // 3) Stream firmware file (only if paid)
      if (url.pathname === "/firmware") {
        const sid = url.searchParams.get("session_id");
        const path = url.searchParams.get("path") || "";
        const ok =
          path.startsWith("firmware-installer/") &&
          !path.includes("..") &&
          BOARDS.some((b) => path.includes(`/${b}/`));
        if (!ok) return json(env, { error: "bad path" }, 400);
        if (!(await assertPaid(env, sid))) return json(env, { error: "not paid" }, 402);

        const f = await fetchFirmware(env, path);
        if (!f.ok) return json(env, { error: "file not found" }, 502);
        return new Response(f.body, {
          headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", ...cors(env) },
        });
      }

      return json(env, { error: "not found" }, 404);
    } catch (e) {
      return json(env, { error: String(e) }, 500);
    }
  },
};
