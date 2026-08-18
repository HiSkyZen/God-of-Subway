export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://www.googletagmanager.com",
  "connect-src 'self' https://www.google-analytics.com https://region1.google-analytics.com https://*.google-analytics.com",
  "img-src 'self' data: https://www.google-analytics.com https://www.googletagmanager.com",
  "style-src 'self'",
  "font-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

export const setSecurityHeaders = (headers: Headers): Headers => {
  headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  return headers;
};

export const withSecurityHeaders = (response: Response): Response => new Response(response.body, {
  status: response.status,
  statusText: response.statusText,
  headers: setSecurityHeaders(new Headers(response.headers)),
});
