import crypto from "crypto";

/** Play Console SKU → 실제 지급량(표시명·ID 숫자와 무관). */
export const COOKIE_IAP_PRODUCTS = {
  cookie_10: { grantAmount: 400, displayBase: 400, displayBonus: 0 },
  cookie_35: { grantAmount: 1400, displayBase: 1200, displayBonus: 200 },
  cookie_65: { grantAmount: 2600, displayBase: 2000, displayBonus: 600 },
  cookie_140: { grantAmount: 5600, displayBase: 4000, displayBonus: 1600 },
};

/** 과거 스토어 SKU → 현재 canonical productId */
const LEGACY_PRODUCT_IDS = {
  cookie_pack_10: "cookie_10",
  cookie_10_pack: "cookie_10",
  cookie_pack_35: "cookie_35",
  cookie_30_pack: "cookie_35",
  cookie_pack_65: "cookie_65",
  cookie_50_pack: "cookie_65",
  cookie_pack_140: "cookie_140",
  cookie_100_pack: "cookie_140",
};

export const COOKIE_IAP_FIRST_PURCHASE_BONUS = 200;

const DEFAULT_PACKAGE_NAME =
  (process.env.GOOGLE_PLAY_PACKAGE_NAME || "com.sojin.focusgauge").trim();

let cachedGoogleAccessToken = null;
let cachedGoogleAccessTokenExpiresAt = 0;
let parsedServiceAccount = null;
let serviceAccountParseAttempted = false;

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getGoogleServiceAccount() {
  if (serviceAccountParseAttempted) return parsedServiceAccount;
  serviceAccountParseAttempted = true;
  const raw = (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) {
    parsedServiceAccount = null;
    return null;
  }
  try {
    parsedServiceAccount = JSON.parse(raw);
  } catch (e) {
    console.log("[iap-cookie] GOOGLE_PLAY_SERVICE_ACCOUNT_JSON parse error:", e);
    parsedServiceAccount = null;
  }
  return parsedServiceAccount;
}

async function getGooglePlayAccessToken() {
  const now = Date.now();
  if (cachedGoogleAccessToken && now < cachedGoogleAccessTokenExpiresAt - 60_000) {
    return cachedGoogleAccessToken;
  }

  const serviceAccount = getGoogleServiceAccount();
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
    return null;
  }

  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = base64url(signer.sign(serviceAccount.private_key));
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    console.log(
      "[iap-cookie] Google OAuth token error:",
      json.error || json.error_description || res.status,
    );
    return null;
  }

  cachedGoogleAccessToken = json.access_token;
  cachedGoogleAccessTokenExpiresAt = now + Number(json.expires_in || 3600) * 1000;
  return cachedGoogleAccessToken;
}

export function resolveCanonicalProductId(productId) {
  const id = String(productId || "").trim();
  if (!id) return null;
  if (COOKIE_IAP_PRODUCTS[id]) return id;
  return LEGACY_PRODUCT_IDS[id] || null;
}

export function iapDedupReason(purchaseToken) {
  const token = String(purchaseToken || "").trim();
  if (!token) return "";
  const digest = crypto.createHash("sha256").update(token).digest("hex").slice(0, 40);
  return `iap:${digest}`;
}

export async function verifyGooglePlayProductPurchase({
  packageName,
  productId,
  purchaseToken,
}) {
  const pkg = (packageName || DEFAULT_PACKAGE_NAME).trim();
  const canonicalId = resolveCanonicalProductId(productId);
  const token = String(purchaseToken || "").trim();
  if (!canonicalId || !token) {
    return { ok: false, status: 400, error: "product_id 또는 purchase_token 필요" };
  }

  const skipVerify = (process.env.IAP_VERIFY_SKIP || "").trim().toLowerCase();
  if (skipVerify === "1" || skipVerify === "true" || skipVerify === "yes") {
    console.warn("[iap-cookie] IAP_VERIFY_SKIP enabled — Play 검증 생략");
    return { ok: true, canonicalProductId: canonicalId, purchaseState: 0 };
  }

  const accessToken = await getGooglePlayAccessToken();
  if (!accessToken) {
    return {
      ok: false,
      status: 503,
      error: "Google Play 검증 설정 없음(GOOGLE_PLAY_SERVICE_ACCOUNT_JSON)",
    };
  }

  const url =
    "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" +
    `${encodeURIComponent(pkg)}/purchases/products/` +
    `${encodeURIComponent(canonicalId)}/tokens/${encodeURIComponent(token)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const bodyText = await res.text();
  let body = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch (_e) {
    body = {};
  }

  if (!res.ok) {
    console.log(
      "[iap-cookie] Play verify failed",
      `productId=${canonicalId}`,
      `status=${res.status}`,
      bodyText.slice(0, 400),
    );
    return {
      ok: false,
      status: 502,
      error: body.error?.message || "Google Play 구매 검증 실패",
    };
  }

  const purchaseState = Number(body.purchaseState);
  if (purchaseState !== 0) {
    return { ok: false, status: 400, error: "구매 상태가 유효하지 않습니다." };
  }

  return { ok: true, canonicalProductId: canonicalId, purchaseState };
}

export async function handleIapCookieVerifyPost(req, res, deps) {
  const { getSupabase, readString, logSupabaseErr } = deps;
  try {
    const supabase = getSupabase();
    if (!supabase) {
      return res.status(500).json({ ok: false, error: "supabase 없음" });
    }

    const user_id = readString(req.body, "user_id");
    const product_id_raw = readString(req.body, "product_id");
    const purchase_token = readString(req.body, "purchase_token");
    const package_name = readString(req.body, "package_name");
    const is_restored = req.body?.is_restored === true;

    if (!user_id || !product_id_raw || !purchase_token) {
      return res.status(400).json({
        ok: false,
        error: "user_id, product_id, purchase_token 필요",
      });
    }

    const canonicalProductId = resolveCanonicalProductId(product_id_raw);
    const productSpec = canonicalProductId
      ? COOKIE_IAP_PRODUCTS[canonicalProductId]
      : null;
    if (!productSpec) {
      return res.status(400).json({ ok: false, error: "알 수 없는 product_id" });
    }

    const dedupReason = iapDedupReason(purchase_token);
    const { data: existingRows, error: existingErr } = await supabase
      .from("cookie_transactions")
      .select("delta")
      .eq("user_id", user_id)
      .eq("reason", dedupReason)
      .limit(1);

    if (existingErr) {
      logSupabaseErr("[iap-cookie] dedup lookup", existingErr);
      return res.status(500).json({ ok: false, error: existingErr.message });
    }

    if (existingRows && existingRows.length > 0) {
      const balance = await sumCookieBalance(supabase, user_id);
      console.log(
        "[iap-cookie] duplicate purchase skipped",
        `user=${user_id}`,
        `productId=${canonicalProductId}`,
      );
      return res.json({
        ok: true,
        duplicate: true,
        productId: canonicalProductId,
        packGrantAmount: productSpec.grantAmount,
        firstPurchaseBonus: 0,
        totalGranted: Number(existingRows[0].delta) || productSpec.grantAmount,
        firstPurchaseBonusApplied: false,
        balance,
      });
    }

    const verify = await verifyGooglePlayProductPurchase({
      packageName: package_name,
      productId: product_id_raw,
      purchaseToken: purchase_token,
    });
    if (!verify.ok) {
      return res.status(verify.status || 502).json({
        ok: false,
        error: verify.error || "구매 검증 실패",
      });
    }

    let firstPurchaseBonus = 0;
    let firstPurchaseBonusApplied = false;
    if (!is_restored) {
      const hadPriorIap = await userHasPriorIapPurchase(supabase, user_id);
      if (!hadPriorIap) {
        firstPurchaseBonus = COOKIE_IAP_FIRST_PURCHASE_BONUS;
        firstPurchaseBonusApplied = true;
      }
    }

    const totalGranted = productSpec.grantAmount + firstPurchaseBonus;
    const platformRaw = readString(req.body, "platform");
    const platform = platformRaw || null;

    const { error: insertErr } = await supabase.from("cookie_transactions").insert([
      {
        user_id,
        delta: totalGranted,
        reason: dedupReason,
        platform,
      },
    ]);

    if (insertErr) {
      logSupabaseErr("[iap-cookie] insert", insertErr);
      return res.status(500).json({ ok: false, error: insertErr.message });
    }

    const balance = await sumCookieBalance(supabase, user_id);
    console.log(
      "[iap-cookie] granted",
      `user=${user_id}`,
      `productId=${canonicalProductId}`,
      `pack=${productSpec.grantAmount}`,
      `firstBonus=${firstPurchaseBonus}`,
      `total=${totalGranted}`,
      `balance=${balance}`,
    );

    return res.status(201).json({
      ok: true,
      duplicate: false,
      productId: canonicalProductId,
      packGrantAmount: productSpec.grantAmount,
      displayBase: productSpec.displayBase,
      displayBonus: productSpec.displayBonus,
      firstPurchaseBonus,
      totalGranted,
      firstPurchaseBonusApplied,
      balance,
    });
  } catch (e) {
    console.log("[iap-cookie]", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

async function sumCookieBalance(supabase, userId) {
  const { data, error } = await supabase
    .from("cookie_transactions")
    .select("delta")
    .eq("user_id", userId);
  if (error) return 0;
  let balance = 0;
  for (const row of data || []) {
    balance += Number(row.delta) || 0;
  }
  return balance;
}

async function userHasPriorIapPurchase(supabase, userId) {
  const { data, error } = await supabase
    .from("cookie_transactions")
    .select("reason")
    .eq("user_id", userId)
    .like("reason", "iap:%");
  if (error) return false;
  return (data || []).length > 0;
}
