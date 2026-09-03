/**
 * Robodepo (working name) approval gesture — MIT
 *
 * One biometric touch in front of the existing confirmation form.
 *
 * What this does: when the browser reports a platform authenticator with user
 * verification (Touch ID on a Mac, a fingerprint or face unlock on Android,
 * Windows Hello, a Google Password Manager passkey), it intercepts the form's
 * submit, asks the browser for that gesture through `navigator.credentials`,
 * and only then submits the form the server rendered — with the server's own
 * single-use `csrf` value and issued `idempotency_key` untouched.
 *
 * What this is NOT: authority. The credential is created and immediately
 * discarded. Nothing derived from it is sent anywhere — not to Robodepo, not
 * to any other origin, not to storage. The server has no idea whether it
 * happened. Every check that actually protects the purchase runs server-side
 * and is unchanged: the run cookie, the confirmation cookie, the single-use
 * CSRF value, the server-issued single-use idempotency key, the same-origin
 * requirement and the five-minute confirmation session.
 *
 * So this is a **user-presence gesture**, not a second factor: it proves a
 * person is at the device at the moment of approval, and it does not survive
 * the trip to the server. On a device with no platform authenticator the page
 * falls back to a plain single-button confirmation, which is exactly what
 * `/confirm/{mandateId}` has always been.
 *
 * Node/vitest safe: everything below is behind a `window` guard.
 */

const APPROVE_LABEL = "Approve with fingerprint or face";
const PLAIN_LABEL = "Confirm sandbox purchase";

const STATUS = {
  approved: "Approved with your device. Sending the confirmation…",
  cancelled:
    "Approval gesture not completed. Nothing was ordered. Try again or use the plain confirmation page.",
  unavailable:
    "This device has no fingerprint or face unlock available to the browser, so the plain confirmation button is shown.",
  ready: "Press the button and confirm with your fingerprint or face.",
};

/** Random bytes for the ceremony. Never sent to Robodepo; never stored. */
function randomBytes(length) {
  const buffer = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buffer);
  return buffer;
}

/**
 * Ask the browser for a user-verifying gesture. The resulting credential is
 * deliberately dropped on the floor: this function returns a boolean and
 * nothing else, so there is no value for a caller to accidentally transmit.
 */
export async function requestApprovalGesture(navigatorRef, hostname) {
  await navigatorRef.credentials.create({
    publicKey: {
      rp: { name: "Robodepo", id: hostname },
      user: {
        id: randomBytes(16),
        name: "sandbox-buyer",
        displayName: "Sandbox buyer",
      },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "discouraged",
      },
      timeout: 60_000,
      attestation: "none",
    },
  });
  return true;
}

/** Is a fingerprint or face unlock actually reachable from this browser? */
export async function platformAuthenticatorAvailable(windowRef) {
  const api = windowRef.PublicKeyCredential;
  if (!api || typeof api.isUserVerifyingPlatformAuthenticatorAvailable !== "function") {
    return false;
  }
  try {
    return (await api.isUserVerifyingPlatformAuthenticatorAvailable()) === true;
  } catch {
    return false;
  }
}

export async function mountApprovalPage(windowRef, doc) {
  const form = doc.getElementById("approve-form");
  const button = doc.getElementById("approve-button");
  const status = doc.getElementById("approve-status");
  if (!form || !button || !status) {
    return { biometric: false };
  }

  if (!(await platformAuthenticatorAvailable(windowRef))) {
    // No gesture is available, so do not pretend one happened. The form is
    // left exactly as the server rendered it: one button, one plain submit.
    button.textContent = PLAIN_LABEL;
    status.textContent = STATUS.unavailable;
    return { biometric: false };
  }

  button.textContent = APPROVE_LABEL;
  status.textContent = STATUS.ready;

  let running = false;
  form.addEventListener("submit", (event) => {
    if (form.dataset.gestureDone === "true") {
      return;
    }
    event.preventDefault();
    if (running) {
      return;
    }
    running = true;
    button.disabled = true;

    requestApprovalGesture(windowRef.navigator, windowRef.location.hostname)
      .then(() => {
        status.textContent = STATUS.approved;
        // The hidden csrf and idempotency_key inputs are the ones the server
        // issued and have not been touched. `submit()` posts them unchanged.
        form.dataset.gestureDone = "true";
        form.submit();
      })
      .catch(() => {
        // Cancelled, timed out, NotAllowedError, no authenticator: all the
        // same outcome. Nothing is ordered and nothing is retried silently.
        status.textContent = STATUS.cancelled;
        running = false;
        button.disabled = false;
      });
  });

  return { biometric: true };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  mountApprovalPage(window, document);
}
