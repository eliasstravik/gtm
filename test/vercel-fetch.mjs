// Test-only preload (NODE_OPTIONS=--import): sends the app's Vercel REST calls to GTM_TEST_VERCEL_API, a local stub
// (helpers.mjs vercelStub), so hosted Connections runs without reaching Vercel. Not part of the package.
const to = process.env.GTM_TEST_VERCEL_API, real = globalThis.fetch, API = "https://api.vercel.com/";
if (to) {
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return real(url.startsWith(API) ? `${to}/${url.slice(API.length)}` : input, init);
  };
}
