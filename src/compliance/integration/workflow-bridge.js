export async function sendComplianceResult({ endpoint, payload }) {
  if (!endpoint) {
    return { ok: false, reason: "missing-endpoint" };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    return {
      ok: response.ok,
      status: response.status
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.message ?? "network-error"
    };
  }
}
