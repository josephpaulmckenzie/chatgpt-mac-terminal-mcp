import { createHash, randomBytes } from "node:crypto";

export type FindingCategory =
  | "possible_person_name"
  | "email_address"
  | "phone_number"
  | "street_address"
  | "local_filesystem_path"
  | "aws_access_key"
  | "github_token"
  | "private_key";

export interface ContentFinding {
  category: FindingCategory;
  line: number;
  value: string;
}

export interface PreflightTicket {
  operation: "write" | "delete";
  repository: string;
  path: string;
  overwrite: boolean;
  currentSha256: string | null;
  proposedSha256: string | null;
  findings: ContentFinding[];
  expiresAt: number;
}

const PERSON_NAME_STOP_WORDS = new Set([
  "Model", "Context", "Protocol", "Command", "Center", "Secure", "Tunnel",
  "Mac", "Terminal", "Local", "Original", "Requirements", "Architecture",
  "License", "Store", "Connect", "Custom", "GitHub", "Actions", "OpenAI",
  "ChatGPT", "Node", "TypeScript", "JavaScript", "AWS", "README", "MCP",
  "Private", "Public", "Access", "Personal", "File", "System", "Default",
  "Repository", "Project", "Source", "Code", "Build", "Review", "Current",
  "Before", "After", "Important", "Security", "Checklist", "Example",
  "Optional", "Required", "Absolute", "Path", "Profile", "Keychain",
  "Second", "First", "Available", "Account", "Workspace", "Connection",
  "Install", "Select", "Create", "Configure", "Start", "Stop", "Run", "Show",
  "Check", "Find", "Every", "Natural", "Language", "Separate", "Until",
  "Rights", "Reserved", "Test", "Files", "Collectors", "Vault", "The", "No", "Do", "Keychain"
]);

const DETECTORS: ReadonlyArray<{
  category: FindingCategory;
  pattern: RegExp;
  redact?: boolean;
}> = [
  { category: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, redact: true },
  { category: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, redact: true },
  { category: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, redact: true },
  { category: "email_address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, redact: true },
  { category: "phone_number", pattern: /\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, redact: true },
  { category: "street_address", pattern: /\b\d{1,6}\s+(?:[A-Z0-9][A-Za-z0-9.'-]*\s+){1,5}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl)\b/gi, redact: true },
  { category: "local_filesystem_path", pattern: /(?:\/Users\/[^\s"'<>]+|\/home\/[^\s"'<>]+|[A-Z]:\\Users\\[^\s"'<>]+)/g, redact: true }
];

export function sha256Text(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isHighRiskFinding(finding: ContentFinding): boolean {
  return finding.category === "aws_access_key" ||
    finding.category === "github_token" ||
    finding.category === "private_key";
}

export function scanSensitiveContent(content: string): ContentFinding[] {
  const findings: ContentFinding[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/);

  const add = (category: FindingCategory, line: number, value: string): void => {
    const key = category + ":" + line + ":" + value;
    if (seen.has(key)) return;
    seen.add(key);
    if (findings.length < 500) findings.push({ category, line, value });
  };

  lines.forEach((text, index) => {
    for (const detector of DETECTORS) {
      detector.pattern.lastIndex = 0;
      for (const match of text.matchAll(detector.pattern)) {
        const value = match[0] ?? "";
        add(detector.category, index + 1, detector.redact ? "[redacted]" : value);
      }
    }

    const personPattern = /\b([A-Z][a-z]{1,24})\s+([A-Z][a-z]{1,24})\b/g;
    for (const match of text.matchAll(personPattern)) {
      const first = match[1] ?? "";
      const last = match[2] ?? "";
      if (PERSON_NAME_STOP_WORDS.has(first) || PERSON_NAME_STOP_WORDS.has(last)) continue;
      add("possible_person_name", index + 1, "[possible name]");
    }
  });

  return findings;
}

export class PreflightTicketStore {
  readonly #tickets = new Map<string, PreflightTicket>();

  issue(ticket: Omit<PreflightTicket, "expiresAt">, now = Date.now()): string {
    this.#prune(now);
    if (this.#tickets.size >= 256) throw new Error("Preflight ticket capacity reached; wait for existing tickets to expire.");
    const token = randomBytes(24).toString("hex");
    this.#tickets.set(token, { ...ticket, findings: ticket.findings.map(finding => ({ ...finding })), expiresAt: now + 5 * 60_000 });
    return token;
  }

  consume(
    token: string,
    expected: Pick<PreflightTicket, "operation" | "repository" | "path" | "overwrite" | "currentSha256" | "proposedSha256">,
    now = Date.now()
  ): PreflightTicket | null {
    const ticket = this.#tickets.get(token);
    this.#tickets.delete(token);
    if (!ticket || ticket.expiresAt <= now) return null;

    if (
      ticket.operation !== expected.operation ||
      ticket.repository !== expected.repository ||
      ticket.path !== expected.path ||
      ticket.overwrite !== expected.overwrite ||
      ticket.currentSha256 !== expected.currentSha256 ||
      ticket.proposedSha256 !== expected.proposedSha256
    ) {
      return null;
    }

    return { ...ticket, findings: ticket.findings.map(finding => ({ ...finding })) };
  }

  #prune(now: number): void {
    for (const [token, ticket] of this.#tickets) {
      if (ticket.expiresAt <= now) this.#tickets.delete(token);
    }
  }
}