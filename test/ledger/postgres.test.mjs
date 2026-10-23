/** The ledger suite on real Postgres: GTM_TEST_PG_URL (CI's service container), in a fresh database. Skipped without it. */
import { test } from "node:test";
import pg from "pg";
import { suite } from "./suite.mjs";

const base = process.env.GTM_TEST_PG_URL;
if (!base) test("ledger on Postgres", { skip: "set GTM_TEST_PG_URL to a Postgres 16 server" }, () => {});
else {
  const name = `gtm_test_${Date.now().toString(36)}`, admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  await suite({ url: url.toString(), concurrent: true });
}
