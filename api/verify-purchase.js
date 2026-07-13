// api/verify-purchase.js
// ---------------------------------------------------------------------------
// Server-side validation of a Google Play subscription purchase.
//
// Flow:
//   1. Verify the caller's Firebase ID token  -> trusted Firebase UID.
//   2. Validate the Play purchase token against the Google Play Developer API
//      (androidpublisher v3, purchases.subscriptionsv2.get).
//   3. Persist the result to Firestore at users/{uid}.entitlement so the client
//      (and any other device) can read a trustworthy entitlement.
//
// Required environment variables (set these in Vercel → Project → Settings → Env):
//   FIREBASE_SERVICE_ACCOUNT_JSON   - Firebase Admin service-account JSON (stringified).
//                                     Firebase console → Project settings → Service accounts
//                                     → "Generate new private key".
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON- Google Cloud service-account JSON (stringified) that has
//                                     access to the Play Developer API. Create it in Google Cloud,
//                                     enable "Google Play Android Developer API", then in Play
//                                     Console → Users & permissions, invite the service-account
//                                     email and grant "View financial data, orders, and
//                                     cancellation survey responses".
//   GOOGLE_PLAY_PACKAGE_NAME        - com.speakersgym.app
//
// NOTE: paste each JSON as a single-line string (or base64 — see parseJsonEnv below).
// ---------------------------------------------------------------------------

import admin from "firebase-admin";
import { google } from "googleapis";

// --- helpers ---------------------------------------------------------------

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`Missing environment variable: ${name}`);
  // Accept either raw JSON or base64-encoded JSON.
  const text = raw.trim().startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(text);
}

// Initialise firebase-admin once (module scope persists across warm invocations).
function getAdmin() {
  if (!admin.apps.length) {
    const serviceAccount = parseJsonEnv("FIREBASE_SERVICE_ACCOUNT_JSON");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  return admin;
}

// Authenticated Google Play Android Publisher client.
function getAndroidPublisher() {
  const creds = parseJsonEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON");
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  return google.androidpublisher({ version: "v3", auth });
}

const ACTIVE_STATES = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
]);

// --- handler ---------------------------------------------------------------

export default async function handler(req, res) {
  // CORS (matches vercel.json) + preflight.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { firebaseIdToken, purchaseToken, productId } = req.body || {};
    if (!firebaseIdToken || !purchaseToken) {
      return res.status(400).json({ error: "firebaseIdToken and purchaseToken are required" });
    }

    const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
    if (!packageName) {
      return res.status(500).json({ error: "Server not configured: GOOGLE_PLAY_PACKAGE_NAME missing" });
    }

    // 1. Verify the Firebase ID token -> trusted UID.
    const fb = getAdmin();
    let uid;
    try {
      const decoded = await fb.auth().verifyIdToken(firebaseIdToken);
      uid = decoded.uid;
    } catch (e) {
      return res.status(401).json({ error: "Invalid Firebase ID token" });
    }

    // 2. Validate the purchase token against Google Play.
    const publisher = getAndroidPublisher();
    let subscriptionState, expiryMs = null;
    try {
      const { data } = await publisher.purchases.subscriptionsv2.get({
        packageName,
        token: purchaseToken,
      });
      subscriptionState = data.subscriptionState;
      // Earliest line-item expiry is the effective access end.
      const expiries = (data.lineItems || [])
        .map((li) => li.expiryTime)
        .filter(Boolean)
        .map((t) => new Date(t).getTime());
      if (expiries.length) expiryMs = Math.max(...expiries);
    } catch (e) {
      console.error("[verify-purchase] Play API error:", e?.message);
      return res.status(502).json({ error: "Could not validate purchase with Google Play" });
    }

    const active = ACTIVE_STATES.has(subscriptionState);

    // 3. Persist entitlement to Firestore (single source of truth).
    const entitlement = {
      active,
      productId: productId || null,
      subscriptionState: subscriptionState || null,
      expiryTime: expiryMs,                 // epoch ms (or null)
      purchaseToken,                        // for reconciliation / RTDN
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await fb.firestore().collection("users").doc(uid).set({ entitlement }, { merge: true });

    return res.status(200).json({
      active,
      productId: productId || null,
      expiryTime: expiryMs,
      subscriptionState: subscriptionState || null,
    });
  } catch (err) {
    console.error("[verify-purchase] unexpected error:", err);
    return res.status(500).json({ error: "Internal error", detail: err?.message });
  }
}
