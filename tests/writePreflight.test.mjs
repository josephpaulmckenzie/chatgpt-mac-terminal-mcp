import assert from "node:assert/strict";
import test from "node:test";
import { isHighRiskFinding, PreflightTicketStore, scanSensitiveContent, sha256Text } from "../dist/writePreflight.js";

test("detects credential-like values without returning their contents", () => {
  const awsKey = ["AKIA", "1234567890ABCDEF"].join("");
  const email = ["jane", "@", "example", ".com"].join("");
  const privateKeyMarker = ["-----BEGIN ", "PRIVATE KEY", "-----"].join("");
  const findings = scanSensitiveContent([
    "AWS key: " + awsKey,
    "Contact: " + email,
    "Private key: " + privateKeyMarker
  ].join("\n"));

  assert.deepEqual(
    findings.map(({ category, line, value }) => ({ category, line, value })),
    [
      { category: "aws_access_key", line: 1, value: "[redacted]" },
      { category: "email_address", line: 2, value: "[redacted]" },
      { category: "private_key", line: 3, value: "[redacted]" }
    ]
  );
});

test("flags person-name candidates and local paths for human review", () => {
  const constructedName = ["Micha", "el ", "Sco", "tt"].join("");
  const localPath = ["/Users/", "example", "/Code/project"].join("");
  const findings = scanSensitiveContent("Author: " + constructedName + "\nPath: " + localPath);
  assert.equal(findings.some(finding => finding.category === "possible_person_name"), true);
  assert.equal(findings.some(finding => finding.category === "local_filesystem_path"), true);
  assert.ok(findings.every(finding => finding.value !== constructedName));
});

test("does not report ordinary technical prose as sensitive", () => {
  assert.deepEqual(scanSensitiveContent("TypeScript build completed successfully."), []);
});

test("hashes strings deterministically", () => {
  assert.equal(sha256Text("hello"), sha256Text("hello"));
  assert.notEqual(sha256Text("hello"), sha256Text("world"));
});

test("preflight tickets are one-use and bound to the exact operation", () => {
  const store = new PreflightTicketStore();
  const ticket = {
    operation: "write",
    repository: "repo",
    path: "README.md",
    overwrite: true,
    currentSha256: "old",
    proposedSha256: "new",
    findings: []
  };
  const token = store.issue(ticket, 100);
  assert.equal(store.consume(token, ticket, 101)?.path, "README.md");
  assert.equal(store.consume(token, ticket, 102), null);
});

test("preflight tickets expire and reject mismatched payloads", () => {
  const store = new PreflightTicketStore();
  const ticket = {
    operation: "delete",
    repository: "repo",
    path: "obsolete.txt",
    overwrite: false,
    currentSha256: "old",
    proposedSha256: null,
    findings: []
  };
  const token = store.issue(ticket, 100);
  assert.equal(store.consume(token, { ...ticket, path: "other.txt" }, 101), null);

  const expiringToken = store.issue(ticket, 100);
  assert.equal(store.consume(expiringToken, ticket, 5 * 60_000 + 101), null);
});
test("preflight tickets defensively copy findings at issue and consume", () => {
  const store = new PreflightTicketStore();
  const findings = [{ category: "email_address", line: 1, value: "[redacted]" }];
  const ticket = {
    operation: "write",
    repository: "repo",
    path: "README.md",
    overwrite: false,
    currentSha256: null,
    proposedSha256: "new",
    findings
  };
  const token = store.issue(ticket, 100);
  findings[0].value = "mutated by caller";
  const consumed = store.consume(token, ticket, 101);
  assert.equal(consumed?.findings[0]?.value, "[redacted]");
  if (consumed) consumed.findings[0].value = "mutated by consumer";
  assert.equal(findings[0]?.value, "mutated by caller");
});

test("personal information is informational, not a high-risk write blocker", () => {
  const findings = scanSensitiveContent([
    "Author: Michael Scott",
    "Contact: michael.scott@dundermifflin.com",
    "Path: /Users/example/Documents/project"
  ].join("\\n"));
  assert.ok(findings.length >= 3);
  assert.equal(findings.some(isHighRiskFinding), false);
});

test("credential and private-key findings remain high risk", () => {
  const awsKey = ["AKIA", "1234567890ABCDEF"].join("");
  const token = ["ghp_", "abcdefghijklmnopqrstuvwxyz123456"].join("");
  const keyMarker = ["-----BEGIN ", "PRIVATE KEY", "-----"].join("");
  const findings = scanSensitiveContent([awsKey, token, keyMarker].join("\\n"));
  assert.equal(findings.filter(isHighRiskFinding).length, 2);
  assert.ok(findings.some(finding => finding.category === "aws_access_key"));
  assert.ok(findings.some(finding => finding.category === "private_key"));
});