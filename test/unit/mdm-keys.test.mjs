/** mdm's matching keys: every spelling of one email, domain or LinkedIn URL gives one key, and junk is refused. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { domain, email, fieldName, keysOf, linkedin, signalType } from "../../dist/plugins/mdm/keys.js";

test("domains: scheme, www, path, port, case and a trailing dot fall away", () => {
  for (const d of ["acme.example", "ACME.example.", "https://www.acme.example/about?x=1", "http://user@acme.example:8080/", "www2.acme.example#top"]) assert.equal(domain(d), "acme.example", d);
  assert.equal(domain("Shop.Acme.co.uk"), "shop.acme.co.uk", "subdomains other than www stay");
  for (const d of ["acme", "not a domain", "acme..example", "-acme.example", "jane@"]) assert.throws(() => domain(d), /is not a domain/, d);
});

test("emails: trimmed and lowercase; LinkedIn: one path per profile or page", () => {
  assert.equal(email("\tJane.Doe@acme.example "), "jane.doe@acme.example");
  assert.equal(email("mailto:jane@acme.example"), "jane@acme.example");
  for (const e of ["jane", "jane@acme", "jane doe@acme.example", "@acme.example"]) assert.throws(() => email(e), /not an email/, e);
  for (const u of ["https://www.linkedin.com/in/Jane-Doe/", "linkedin.com/in/jane-doe?trk=x", "uk.linkedin.com/in/jane-doe", "http://linkedin.com/in/jane%2Ddoe"]) {
    assert.equal(linkedin(u, "person"), "linkedin.com/in/jane-doe", u);
  }
  assert.equal(linkedin("https://www.linkedin.com/company/Acme-Inc/about/", "company"), "linkedin.com/company/acme-inc");
  assert.equal(linkedin("linkedin.com/school/acme-u", "company"), "linkedin.com/school/acme-u");
  assert.throws(() => linkedin("linkedin.com/company/acme", "person"), /not a LinkedIn profile/);
  assert.throws(() => linkedin("linkedin.com/in/jane", "company"), /not a LinkedIn company page/);
  assert.throws(() => linkedin("https://example.com/in/jane", "person"), /not a LinkedIn profile/);
});

test("keysOf: ids first, then email or domain, then LinkedIn; names of fields and signal types are checked", () => {
  assert.deepEqual(keysOf("person", { email: "J@acme.example", linkedin: "linkedin.com/in/j", ids: { hubspot: 7 }, name: "J" }),
    [["id:hubspot", "7"], ["email", "j@acme.example"], ["linkedin", "linkedin.com/in/j"]]);
  assert.deepEqual(keysOf("company", { domain: "acme.example", email: "ignored@x.example" }), [["domain", "acme.example"]]);
  assert.deepEqual(keysOf("person", { email: " ", linkedin: null }), []);
  assert.throws(() => keysOf("company", { ids: { "Bad System": "1" } }), /not a system name/);
  assert.throws(() => keysOf("company", { ids: { crm: "" } }), /id is empty/);
  assert.equal(fieldName("employee_count"), "employee_count");
  assert.throws(() => fieldName("email"), /its own input/);
  assert.throws(() => fieldName("1st"), /not a field name/);
  assert.equal(signalType("job_change"), "job_change");
  assert.throws(() => signalType("Job change"), /not a signal type/);
});
